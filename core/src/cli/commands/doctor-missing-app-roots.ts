import { scanMissingAppRoots } from "@lando/engine/operations/missing-app-roots";
import { FileSystem, RuntimeProviderRegistry } from "@lando/sdk/services";
import { Effect, Option, Result } from "effect";
import { warnCheck } from "./doctor-check-builders";
import type { DoctorSubsystemCheck } from "./doctor-subsystem-checks";

export const missingAppRootsDoctor = Effect.fnUntraced(function* (redact: (text: string) => string) {
  const registry = yield* Effect.serviceOption(RuntimeProviderRegistry);
  const fs = yield* Effect.serviceOption(FileSystem);
  if (Option.isNone(registry) || Option.isNone(fs)) return [];
  const inventory = yield* scanMissingAppRoots().pipe(
    Effect.provideService(RuntimeProviderRegistry, registry.value),
    Effect.provideService(FileSystem, fs.value),
    Effect.result,
  );
  if (Result.isFailure(inventory)) {
    const message = inventory.failure.message;
    const check: DoctorSubsystemCheck = warnCheck({
      name: "missing-app-root-scan",
      recovery: "manual",
      context: { error: redact(message) },
      solutions: [
        {
          kind: "manual",
          description: redact(
            `Lando could not read app state to look for app folders that no longer exist: ${message} Fix that problem, then rerun lando doctor.`,
          ),
        },
      ],
    });
    return [check];
  }
  const scanChecks: DoctorSubsystemCheck[] = inventory.success.scans
    .filter((scan) => scan.errorTag !== undefined)
    .map((scan) =>
      warnCheck({
        name: "missing-app-root-scan",
        recovery: "manual",
        context: { error: redact(scan.message) },
        solutions: [
          {
            kind: "manual",
            description: redact(
              `Lando could not read app state to look for app folders that no longer exist: ${scan.message} Fix that problem, then rerun lando doctor.`,
            ),
          },
        ],
      }),
    );
  const command = `lando apps:gc --prune --volumes${inventory.success.candidates.some((root) => root.cacheVolumes.length > 0) ? " --purge-caches" : ""}`;
  return [
    ...scanChecks,
    ...inventory.success.candidates.map((record): DoctorSubsystemCheck => {
      const runtimeGuidance = record.runtimeObserved
        ? ""
        : " Its runtime was not observed, so containers and volumes may be missing from this list.";
      const description = `The app folder no longer exists. If you moved the app, move it back to that path and keep using it. Otherwise, this command cleans up all missing app roots and deletes their data volumes, including file-sync copies of app files; drop --volumes to keep data and those copies.${runtimeGuidance}`;
      return warnCheck({
        name: "missing-app-root",
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
            ...(record.journals.length === 0
              ? {}
              : {
                  attempts: record.journals.map((journal) => journal.attemptId).join(", "),
                  phases: record.journals.map((journal) => journal.phase).join(", "),
                  engines: record.journals.map((journal) => journal.engineId).join(", "),
                  sessions: record.journals
                    .flatMap((journal) => journal.sessions.map((session) => session.name))
                    .join(", "),
                  targets: record.journals
                    .flatMap((journal) => journal.targets.map((target) => target.volumeName))
                    .join(", "),
                }),
          })
            .filter(([, value]) => value !== "")
            .map(([key, value]) => [key, redact(value)]),
        ),
        solutions: [{ kind: "manual", description: redact(description), command: redact(command) }],
      });
    }),
  ];
});
