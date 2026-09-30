import { findMissingAppRoots } from "@lando/engine/operations/missing-app-roots";
import { shellArg } from "@lando/engine/services/shell-quote";
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
      const command = `lando destroy --root ${shellArg(record.root)} --volumes${record.cacheVolumes.length > 0 ? " --purge-caches" : ""}`;
      const runtimeGuidance = record.runtimeObserved
        ? ""
        : " Its runtime was not running, so containers and volumes may be missing from this list. Start the runtime, then rerun lando doctor before you clean up.";
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
