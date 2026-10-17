import { SNAPSHOT_STORE_LABEL, VOLUME_SNAPSHOT_LABEL } from "@lando/container-runtime/labels";
import { DataTransferError } from "@lando/sdk/errors";
import type { SnapshotInfo, VolumeSnapshotArtifact } from "@lando/sdk/schema";
import type { DataMoverError, RuntimeProviderShape } from "@lando/sdk/services";
import { Clock, DateTime, Effect } from "effect";

export const SNAPSHOT_ORPHAN_GRACE_MS = 60 * 60 * 1000;

export const orphanedSnapshotMethods = (options: {
  readonly provider: RuntimeProviderShape;
  readonly storeIdentity: Effect.Effect<string, DataMoverError>;
  readonly index: Effect.Effect<ReadonlyArray<SnapshotInfo>, DataMoverError>;
}) => {
  const failure = (cause: unknown) =>
    new DataTransferError({
      operation: "orphanedSnapshots",
      message: "Provider snapshot reconciliation failed.",
      remediation: "Check provider health with lando doctor and retry.",
      cause,
    });
  const eligible = Effect.fn("DataMover.orphanedSnapshotEligible")(function* (
    artifact: VolumeSnapshotArtifact,
    index: ReadonlyArray<SnapshotInfo>,
  ) {
    if (artifact.ref.provider !== options.provider.id) return false;
    const identity = yield* options.storeIdentity;
    if (
      artifact.labels[SNAPSHOT_STORE_LABEL] !== identity &&
      artifact.labels[VOLUME_SNAPSHOT_LABEL] !== undefined
    )
      return false;
    if (
      DateTime.toEpochMillis(artifact.createdAt) >
      (yield* Clock.currentTimeMillis) - SNAPSHOT_ORPHAN_GRACE_MS
    )
      return false;
    return !index.some(
      (info) => info.native?.provider === artifact.ref.provider && info.native.id === artifact.ref.id,
    );
  });
  return {
    findOrphanedSnapshots: Effect.gen(function* () {
      const artifacts = yield* (options.provider.listVolumeSnapshots?.() ?? Effect.succeed([])).pipe(
        Effect.mapError(failure),
      );
      const index = yield* options.index;
      return yield* Effect.filter(artifacts, (artifact) => eligible(artifact, index));
    }),
    removeOrphanedSnapshot: Effect.fn("DataMover.removeOrphanedSnapshot")(function* (
      artifact: VolumeSnapshotArtifact,
    ) {
      if (!(yield* eligible(artifact, yield* options.index))) {
        return yield* Effect.fail(
          new DataTransferError({
            operation: "removeOrphanedSnapshot",
            message: `Snapshot ${artifact.ref.id} is no longer eligible for orphan removal.`,
            remediation:
              "Run lando snapshots:gc again to review the current orphan report before retrying cleanup.",
          }),
        );
      }
      const remove = options.provider.removeVolumeSnapshot;
      if (remove === undefined) return yield* Effect.fail(failure("Provider cannot remove snapshot images."));
      yield* Effect.scoped(remove(artifact.ref)).pipe(Effect.mapError(failure));
    }),
  };
};
