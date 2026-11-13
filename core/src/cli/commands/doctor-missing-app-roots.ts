import { scanMissingAppRoots } from "@lando/engine/operations/missing-app-roots";
import { FileSystem, RuntimeProviderRegistry } from "@lando/sdk/services";
import { Effect, Option, Result } from "effect";
import { warnCheck } from "./doctor-check-builders";
import type { DoctorFinding } from "./doctor-contract";

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
    const check: DoctorFinding = warnCheck({
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
  const scanChecks: DoctorFinding[] = inventory.success.scans
    .filter((scan) => scan.errorTag !== undefined)
    .map((scan) =>
      warnCheck({
        name: "missing-app-root-scan",
        recovery: "manual",
        subject: redact(scan.providerId),
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
  const copiesRemovable = inventory.success.candidates.every((root) => root.fileSyncCopiesRemovable);
  const command = `lando apps:gc --prune${copiesRemovable ? " --volumes" : ""}${inventory.success.candidates.some((root) => root.cacheVolumes.length > 0) ? " --purge-caches" : ""}`;
  return [
    ...scanChecks,
    ...inventory.success.candidates.map((record): DoctorFinding => {
      const runtimeGuidance = record.runtimeObserved
        ? ""
        : " Its runtime was not observed, so containers and volumes may be missing from this list.";
      const cleanup = copiesRemovable
        ? "Otherwise, this command cleans up all missing app roots and deletes their data volumes, including file-sync copies of app files; drop --volumes to keep data and those copies."
        : `${record.fileSyncCopiesRemovable ? "Another missing app root has file-sync copies Lando cannot remove yet." : "Lando cannot remove this provider's file-sync copies of a deleted app yet. The copies are kept."} Run lando apps:gc --prune without --volumes to remove everything else while keeping data volumes, file-sync copies and their ownership journals; caches are kept unless --purge-caches is set.`;
      const description = `The app folder no longer exists. If you moved the app, move it back to that path and keep using it. ${cleanup}${runtimeGuidance}`;
      return warnCheck({
        name: "missing-app-root",
        subject: redact(record.root),
        recovery: "manual",
        context: Object.fromEntries(
          Object.entries({
            appRoot: record.root,
            apps: record.apps,
            providers: record.providers,
            appliedState: String(record.appliedState),
            runtimeObserved: String(record.runtimeObserved),
            containers: record.services,
            dataVolumes: record.dataVolumes,
            cacheVolumes: record.cacheVolumes,
            attempts: record.journals.map((journal) => journal.attemptId),
            phases: record.journals.map((journal) => journal.phase),
            engines: record.journals.map((journal) => journal.engineId),
            sessions: record.journals.flatMap((journal) => journal.sessions.map((session) => session.name)),
            targets: record.journals.flatMap((journal) => journal.targets.map((target) => target.volumeName)),
          })
            .filter(([, value]) => (typeof value === "string" ? value !== "" : value.length > 0))
            .map(([key, value]) => [key, typeof value === "string" ? redact(value) : value.map(redact)]),
        ),
        solutions: [{ kind: "manual", description: redact(description), command: redact(command) }],
      });
    }),
  ];
});
