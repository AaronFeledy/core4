import { SqlRecoveryUnavailableError } from "@lando/sdk/errors";
import { type SnapshotInfo, compareDataSeries } from "@lando/sdk/schema";
import { Effect } from "effect";

import type { SqlRecoveryContext } from "./recovery.ts";

const hasCompatibleOwner = (source: SnapshotInfo, context: SqlRecoveryContext): boolean =>
  source.metadata?.family === context.metadata.family &&
  source.metadata.service === context.metadata.service &&
  source.owner.ownerKey === context.owner.ownerKey &&
  source.owner.appRoot === context.owner.appRoot;

export const requireSeedCompatibleSnapshot = (
  source: SnapshotInfo | undefined,
  context: SqlRecoveryContext,
): Effect.Effect<void, SqlRecoveryUnavailableError> => {
  const metadata = source?.metadata;
  return source !== undefined &&
    hasCompatibleOwner(source, context) &&
    metadata?.version !== undefined &&
    metadata.version === context.metadata.version &&
    metadata.imageIdentity === context.metadata.imageIdentity
    ? Effect.void
    : Effect.fail(
        new SqlRecoveryUnavailableError({
          message: `Snapshot ${source?.id ?? "(missing)"} is not physically compatible with ${context.metadata.service}.`,
          service: context.metadata.service,
          reason: "Snapshot ownership, service, family, version, or image does not match.",
          remediation: "Use a matching physical snapshot or move data with logical export and import.",
        }),
      );
};

export const requireRestoreCompatibleSnapshot = (
  source: SnapshotInfo | undefined,
  context: SqlRecoveryContext,
  desiredSeries?: { readonly image: string; readonly depth: 1 | 2; readonly anySeries: boolean },
) =>
  (desiredSeries === undefined
    ? requireSeedCompatibleSnapshot(source, context)
    : Effect.suspend(() => {
        const series = source?.metadata?.dataVersion;
        const order =
          series === undefined || series.source === "applied-plan"
            ? undefined
            : compareDataSeries(series.series, desiredSeries.image, desiredSeries.depth);
        if (
          source !== undefined &&
          hasCompatibleOwner(source, context) &&
          (series === undefined || series.label === context.metadata.dataVersion?.label) &&
          (desiredSeries.anySeries || order === 0)
        )
          return Effect.void;
        return Effect.fail(
          new SqlRecoveryUnavailableError({
            message: `Snapshot ${source?.id ?? "(missing)"} is not physically compatible with ${context.metadata.service}.`,
            service: context.metadata.service,
            reason:
              order === undefined
                ? "The snapshot's data version series is unverified, or its ownership, service, or family does not match."
                : "Snapshot ownership, service, database family, or data version series does not match the requested service.",
            remediation:
              "Use a snapshot of this app and service and select its series. Pass `--any-series` only if you have independently checked the series of the data being restored.",
          }),
        );
      })
  ).pipe(
    Effect.andThen(() =>
      source?.metadata?.volumeInstanceId === context.metadata.volumeInstanceId &&
      source?.store.app === context.volume.app &&
      source.store.store === context.volume.store
        ? Effect.void
        : Effect.fail(
            new SqlRecoveryUnavailableError({
              message: `Snapshot ${source?.id ?? "(missing)"} is not physically compatible with ${context.metadata.service}.`,
              service: context.metadata.service,
              reason: "Snapshot physical volume identity does not match.",
              remediation:
                "Restore only to the original physical volume instance, or seed a fresh volume of the same app and service.",
            }),
          ),
    ),
  );
