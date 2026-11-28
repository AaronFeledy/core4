import { SqlRecoveryUnavailableError } from "@lando/sdk/errors";
import { type SnapshotInfo, compareDataSeries } from "@lando/sdk/schema";
import { Effect } from "effect";
import type { SqlCommandDeps } from "./command-types.ts";
import type { SqlPlanService } from "./views.ts";

export const planSeriesRestore = Effect.fn("Sql.planSeriesRestore")(function* (input: {
  readonly source: SnapshotInfo;
  readonly service: SqlPlanService;
  readonly desiredDataVersion: SqlCommandDeps["desiredDataVersion"];
  readonly anySeries: boolean;
}) {
  const { service, source, desiredDataVersion, anySeries } = input;
  const metadata = source.metadata;
  if (metadata === undefined) return undefined;
  const snapshot = metadata.dataVersion;
  if (snapshot === undefined && metadata.recoveryReason !== "upgrade") return undefined;
  const applied = service.dataVersion;
  const current = applied?.series;
  const desired = yield* desiredDataVersion?.(service.name) ?? Effect.succeed(undefined);
  const requested = desired?.series;
  if (
    applied === undefined ||
    desired === undefined ||
    current?.image === undefined ||
    requested?.image === undefined ||
    applied.target !== desired.target ||
    current.depth !== requested.depth ||
    applied.label !== desired.label ||
    (snapshot !== undefined && snapshot.label !== applied.label)
  )
    return yield* new SqlRecoveryUnavailableError({
      service: service.name,
      message: `Cannot prove the database series for restore point ${source.id}.`,
      reason:
        "The snapshot, applied service, and Landofile must identify the same database family and data mount.",
      remediation:
        "Use the original database service and select the snapshot's series in the Landofile, then retry.",
    });
  const verifiedSeries = snapshot?.source === "applied-plan" ? undefined : snapshot?.series;
  const matchesApplied =
    verifiedSeries !== undefined && compareDataSeries(verifiedSeries, current.image, current.depth) === 0;
  const matchesDesired =
    verifiedSeries !== undefined && compareDataSeries(verifiedSeries, requested.image, requested.depth) === 0;
  const pin = `lando app:config:set services.${service.name}.type ${metadata.family}:${snapshot?.series ?? requested.image}`;
  return {
    currentDataVersion: { label: applied.label, series: current.image, source: "applied-plan" as const },
    desiredSeries: { image: requested.image, depth: requested.depth, anySeries },
    resume: matchesApplied,
    restoredSeries: verifiedSeries,
    startCommands: matchesDesired ? ["lando start"] : [pin, "lando start"],
    undoPin: `lando app:config:set services.${service.name}.type ${metadata.family}:${current.image}`,
  };
});
