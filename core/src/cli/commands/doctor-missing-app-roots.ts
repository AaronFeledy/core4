import { findMissingAppRoots } from "@lando/engine/operations/missing-app-roots";
import { quoteShellPath } from "@lando/engine/services/shell-quote";
import { FileSystem, RuntimeProviderRegistry } from "@lando/sdk/services";
import { Effect, Option } from "effect";
import type { DoctorSubsystemCheck } from "./doctor-subsystem-checks";

export const missingAppRootsDoctor = (redact: (text: string) => string) =>
  Effect.gen(function* () {
    const registry = yield* Effect.serviceOption(RuntimeProviderRegistry);
    const fs = yield* Effect.serviceOption(FileSystem);
    if (Option.isNone(registry) || Option.isNone(fs)) return [];
    const roots = yield* findMissingAppRoots.pipe(
      Effect.provideService(RuntimeProviderRegistry, registry.value),
      Effect.provideService(FileSystem, fs.value),
    );
    return roots.map((record): DoctorSubsystemCheck => {
      const root = /^[a-zA-Z0-9_./:-]+$/.test(record.root) ? record.root : quoteShellPath(record.root);
      const command = `lando destroy --root ${root} --volumes${record.cacheVolumes.length > 0 ? " --purge-caches" : ""}`;
      const runtimeGuidance = record.runtimeObserved
        ? ""
        : " The runtime was not running, so containers and volumes may be missing from this list. Check its status with lando setup, start the runtime by starting any app, and rerun doctor before cleaning up.";
      const description = `The app folder no longer exists. If you moved the app, move it back to that path and keep using it. Otherwise, this command removes its containers and deletes its data volumes; drop --volumes to keep data.${runtimeGuidance}`;
      return {
        name: "missing-app-root",
        status: "warn",
        severity: "warn",
        recovery: "manual",
        context: Object.fromEntries(
          Object.entries({
            appRoot: record.root,
            apps: record.apps.join(", "),
            providers: record.providers.join(", "),
            appliedState: String(record.appliedState),
            runtimeObserved: String(record.runtimeObserved),
            ...(record.services.length === 0 ? {} : { containers: record.services.join(", ") }),
            ...(record.dataVolumes.length === 0 ? {} : { dataVolumes: record.dataVolumes.join(", ") }),
            ...(record.cacheVolumes.length === 0 ? {} : { cacheVolumes: record.cacheVolumes.join(", ") }),
          }).map(([key, value]) => [key, redact(value)]),
        ),
        solutions: [{ kind: "manual", description: redact(description), command: redact(command) }],
      };
    });
  });
