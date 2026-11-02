import { findLegacySnapshotCatalogs } from "@lando/data-mover/orphaned-snapshots";
import { PathsService } from "@lando/sdk/services";
import { Effect, Option, Result } from "effect";
import { passCheckNamed, warnCheck } from "./doctor-check-builders";
import type { DoctorSubsystemCheck } from "./doctor-subsystem-checks";

export const legacySnapshotCatalogsDoctor = Effect.fnUntraced(function* (redact: (text: string) => string) {
  const paths = yield* Effect.serviceOption(PathsService);
  if (Option.isNone(paths)) return [];
  const found = yield* findLegacySnapshotCatalogs(paths.value).pipe(Effect.result);
  if (Result.isFailure(found)) {
    const message = found.failure.message;
    return [
      warnCheck({
        name: "legacy-snapshot-catalogs",
        recovery: "manual",
        context: { error: redact(message) },
        solutions: [
          {
            kind: "manual",
            description: redact(
              `Lando could not read the snapshot folder to look for old snapshot catalogs: ${message} Fix that problem, then rerun lando doctor.`,
            ),
          },
        ],
      }),
    ];
  }
  const catalogs = found.success;
  const context = { count: String(catalogs.length), paths: catalogs.map(redact).join("\n") };
  const check: DoctorSubsystemCheck =
    catalogs.length === 0
      ? passCheckNamed({ name: "legacy-snapshot-catalogs", recovery: "manual", context })
      : warnCheck({
          name: "legacy-snapshot-catalogs",
          recovery: "manual",
          context,
          solutions: [
            {
              kind: "manual",
              description:
                "These snapshot catalogs were written by a development build. Their snapshots are no longer listed or restorable, but the catalogs still protect the provider images they reference from lando snapshots:gc. Deleting a catalog directory releases that protection so GC can reclaim the images. Delete it only when you no longer need to keep those images, then run lando snapshots:gc to review them.",
            },
          ],
        });
  return [check];
});
