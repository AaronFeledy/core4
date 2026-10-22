import { sha256Hex } from "@lando/sdk/digest";
import { DataTransferError, StateStoreError } from "@lando/sdk/errors";
import { ProviderId, type SnapshotHandle } from "@lando/sdk/schema";
import type { RuntimeProviderShape } from "@lando/sdk/services";
import { Effect } from "effect";
import {
  type SnapshotPersistence,
  findSnapshotInfo,
  openSnapshot,
  removeEmptySnapshotDirectories,
  removeSnapshotArchive,
} from "./snapshot-catalog.ts";
import { snapshotArchivePath, snapshotPaths, stateFailure } from "./snapshot-paths.ts";

export const removeCatalogSnapshot = Effect.fn("DataMover.removeCatalogSnapshot")(function* (
  persistence: SnapshotPersistence,
  provider: RuntimeProviderShape,
  handle: SnapshotHandle,
) {
  yield* snapshotPaths(persistence.paths, handle);
  yield* persistence.stateStore
    .withLock(
      sha256Hex(JSON.stringify(["snapshot", handle.ownerKey, handle.id])),
      Effect.gen(function* () {
        const info = yield* findSnapshotInfo(persistence, handle);
        const archive = yield* snapshotArchivePath(persistence.paths, info);
        if (info.native !== undefined) {
          const recordingId = info.native.provider;
          const failure = (cause: unknown) =>
            new DataTransferError({
              message: `Provider ${recordingId} could not remove snapshot ${info.id}.`,
              operation: "removeVolumeSnapshot",
              cause,
              remediation: `Make the recording provider ${recordingId} available and retry; the snapshot remains catalogued.`,
            });
          const recording =
            recordingId === provider.id
              ? provider
              : yield* (
                  persistence.providerRegistry?.select(ProviderId.make(recordingId)) ??
                  Effect.fail(failure("Provider registry is unavailable."))
                ).pipe(Effect.mapError(failure));
          yield* Effect.scoped(recording.removeVolumeSnapshot(info.native)).pipe(Effect.mapError(failure));
        }
        yield* removeSnapshotArchive(archive);
        const bucket = yield* openSnapshot(persistence, handle);
        yield* bucket.remove.pipe(Effect.mapError((cause) => stateFailure("remove-sidecar", cause)));
        yield* removeEmptySnapshotDirectories(persistence, info);
      }),
    )
    .pipe(
      Effect.mapError((cause) => (cause instanceof StateStoreError ? stateFailure("lock", cause) : cause)),
    );
});
