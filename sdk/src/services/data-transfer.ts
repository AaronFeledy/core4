import { Context, type Effect, type Scope, type Stream } from "effect";
import type {
  ArchiveFormatError,
  DataChecksumMismatchError,
  DataEndpointUnsupportedError,
  DataSourceOutsideRootError,
  DataTargetExistsError,
  DataTransferError,
  SnapshotAmbiguousError,
  SnapshotNotFoundError,
  SnapshotOwnershipError,
  StateStoreError,
  VolumeNotFoundError,
} from "../errors/index.ts";
import type {
  DataEndpoint,
  DataTransferProgress,
  DataTransferResult,
  DataTransferSpec,
  PrunePolicy,
  SnapshotFilter,
  SnapshotHandle,
  SnapshotId,
  SnapshotInfo,
  SnapshotOptions,
  SnapshotRestoreOptions,
  VolumeRef,
  VolumeSnapshotArtifact,
} from "../schema/index.ts";
import type { VolumeIdentity } from "../schema/volume-identity.ts";
import type { VolumeInitialization } from "./volume-initialization.ts";

export type DataMoverError =
  | DataTransferError
  | DataEndpointUnsupportedError
  | DataChecksumMismatchError
  | DataSourceOutsideRootError
  | DataTargetExistsError
  | SnapshotAmbiguousError
  | SnapshotNotFoundError
  | SnapshotOwnershipError
  | VolumeNotFoundError
  | ArchiveFormatError;

export class DataMover extends Context.Service<
  DataMover,
  {
    readonly volumeInitialization?: (
      identity: VolumeIdentity,
    ) => Effect.Effect<VolumeInitialization, StateStoreError>;
    readonly transfer: (
      spec: DataTransferSpec,
    ) => Effect.Effect<DataTransferResult, DataMoverError, Scope.Scope>;
    readonly transferStream: (
      spec: DataTransferSpec,
    ) => Stream.Stream<DataTransferProgress, DataMoverError, Scope.Scope>;
    /**
     * Yield source endpoint bytes for a caller-owned sink.
     * Success means the source reached EOF and its producer exited cleanly;
     * it does not certify sink receipt.
     */
    readonly read: (from: DataEndpoint) => Stream.Stream<Uint8Array, DataMoverError, Scope.Scope>;
    readonly snapshot: (
      store: VolumeRef,
      opts?: SnapshotOptions,
    ) => Effect.Effect<SnapshotHandle, DataMoverError, Scope.Scope>;
    readonly restore: (
      handle: SnapshotHandle,
      target: VolumeRef,
      opts?: SnapshotRestoreOptions,
    ) => Effect.Effect<void, DataMoverError, Scope.Scope>;
    readonly listSnapshots: (
      filter: SnapshotFilter,
    ) => Effect.Effect<ReadonlyArray<SnapshotInfo>, DataMoverError>;
    /** Resolve ids and labels only within the supplied scope. */
    readonly resolveSnapshot: (
      reference: string,
      scope: SnapshotFilter,
    ) => Effect.Effect<SnapshotInfo, DataMoverError>;
    readonly removeSnapshot: (handle: SnapshotHandle) => Effect.Effect<void, DataMoverError>;
    readonly findOrphanedSnapshots: Effect.Effect<ReadonlyArray<VolumeSnapshotArtifact>, DataMoverError>;
    readonly removeOrphanedSnapshot: (
      artifact: VolumeSnapshotArtifact,
    ) => Effect.Effect<void, DataMoverError>;
    readonly pruneSnapshots: (
      policy: PrunePolicy,
    ) => Effect.Effect<ReadonlyArray<SnapshotId>, DataMoverError>;
  }
>()("@lando/core/DataMover") {}

export type DataMoverShape = DataMover["Service"];
export { SnapshotGcReport } from "../schema/data-transfer.ts";
