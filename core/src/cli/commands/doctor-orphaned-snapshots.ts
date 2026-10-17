import { snapshotGc } from "@lando/engine/operations/snapshot-gc";
import { DataMover, RuntimeProviderRegistry } from "@lando/sdk/services";
import { Effect, Option } from "effect";
import { passCheckNamed, warnCheck } from "./doctor-check-builders";
import type { DoctorSubsystemCheck } from "./doctor-subsystem-checks";
import { snapshotBytes } from "./snapshots-gc";

export const orphanedSnapshotsDoctor = Effect.fnUntraced(function* (redact: (text: string) => string) {
  const registry = yield* Effect.serviceOption(RuntimeProviderRegistry);
  const mover = yield* Effect.serviceOption(DataMover);
  if (Option.isNone(registry) || Option.isNone(mover)) return [];
  const report = yield* snapshotGc().pipe(
    Effect.provideService(RuntimeProviderRegistry, registry.value),
    Effect.provideService(DataMover, mover.value),
  );
  const context = {
    count: String(report.totalCount),
    size: snapshotBytes(report.totalBytes),
    ...(report.providers.some((provider) => provider.status === "unavailable")
      ? {
          note: redact(
            `Skipped unavailable providers: ${report.providers
              .filter((provider) => provider.status === "unavailable")
              .map((provider) => provider.provider)
              .join(", ")}. No stopped runtime was started.`,
          ),
        }
      : {}),
  };
  const check: DoctorSubsystemCheck =
    report.totalCount === 0
      ? passCheckNamed({ name: "orphaned-volume-snapshots", recovery: "manual", context })
      : warnCheck({
          name: "orphaned-volume-snapshots",
          recovery: "manual",
          context,
          solutions: [
            {
              kind: "manual",
              description: "Remove snapshot images no snapshot index references.",
              command: "lando snapshots:gc --prune",
            },
          ],
        });
  return [check];
});
