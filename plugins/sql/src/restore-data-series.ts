import { SqlRecoveryUnavailableError } from "@lando/sdk/errors";
import { type SnapshotInfo, compareDataSeries } from "@lando/sdk/schema";
import { Effect } from "effect";
import type { SqlCommandDeps } from "./command-types.ts";
import type { SqlPlanService } from "./views.ts";

export const planSeriesRestore = Effect.fn("Sql.planSeriesRestore")(function* (input: {
  readonly source: SnapshotInfo;
  readonly service: SqlPlanService;
  readonly desiredDataVersion: SqlCommandDeps["desiredDataVersion"];
}) {
  const { service, source, desiredDataVersion } = input;
  const metadata = source.metadata;
  if (metadata === undefined) return undefined;
  const snapshot = metadata.dataVersion;
  if (snapshot === undefined && metadata.recoveryReason !== "upgrade") return undefined;
  const applied = service.dataVersion;
  const current = applied?.series;
  const desired = yield* desiredDataVersion?.(service.name) ?? Effect.succeed(undefined);
  const requested = desired?.series;
  if (
    snapshot === undefined ||
    applied === undefined ||
    desired === undefined ||
    current?.image === undefined ||
    requested?.image === undefined ||
    applied.target !== desired.target ||
    current.depth !== requested.depth ||
    snapshot.label !== applied.label ||
    snapshot.label !== desired.label
  )
    return yield* new SqlRecoveryUnavailableError({
      service: service.name,
      message: `Cannot prove the database series for restore point ${source.id}.`,
      reason:
        "The snapshot, applied service, and Landofile must identify the same database family and data mount.",
      remediation:
        "Use the original database service and select the snapshot's series in the Landofile, then retry.",
    });
  const matchesApplied = compareDataSeries(snapshot.series, current.image, current.depth) === 0;
  const matchesDesired = compareDataSeries(snapshot.series, requested.image, requested.depth) === 0;
  const pin = `${metadata.family}:${snapshot.series}`;
  return {
    currentDataVersion: { label: applied.label, series: current.image, source: "applied-plan" as const },
    desiredSeries: { image: requested.image, depth: requested.depth },
    resume: matchesApplied,
    nextStep:
      matchesApplied && matchesDesired
        ? undefined
        : matchesDesired
          ? "Run `lando start` to start the database on the restored series."
          : `Set \`services.${service.name}.type\` to \`${pin}\` (or pin a matching image), then run \`lando start\`.`,
  };
});
