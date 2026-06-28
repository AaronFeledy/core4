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
  VolumeNotFoundError,
} from "../errors/index.ts";
import type {
  DataTransferProgress,
  DataTransferResult,
  DataTransferSpec,
  PrunePolicy,
  SnapshotFilter,
  SnapshotHandle,
  SnapshotId,
  SnapshotInfo,
  SnapshotOptions,
  VolumeRef,
} from "../schema/index.ts";

export type DataMoverError =
  | DataTransferError
  | DataEndpointUnsupportedError
  | DataChecksumMismatchError
  | DataSourceOutsideRootError
  | DataTargetExistsError
  | SnapshotAmbiguousError
  | SnapshotNotFoundError
  | VolumeNotFoundError
  | ArchiveFormatError;

export interface DataMoverShape {
  readonly transfer: (
    spec: DataTransferSpec,
  ) => Effect.Effect<DataTransferResult, DataMoverError, Scope.Scope>;
  readonly transferStream: (
    spec: DataTransferSpec,
  ) => Stream.Stream<DataTransferProgress, DataMoverError, Scope.Scope>;
  readonly snapshot: (
    store: VolumeRef,
    opts?: SnapshotOptions,
  ) => Effect.Effect<SnapshotHandle, DataMoverError, Scope.Scope>;
  readonly restore: (
    handle: SnapshotHandle | SnapshotId,
    store: VolumeRef,
  ) => Effect.Effect<void, DataMoverError, Scope.Scope>;
  readonly listSnapshots: (
    filter: SnapshotFilter,
  ) => Effect.Effect<ReadonlyArray<SnapshotInfo>, DataMoverError>;
  readonly removeSnapshot: (id: SnapshotId, store?: VolumeRef) => Effect.Effect<void, DataMoverError>;
  readonly pruneSnapshots: (policy: PrunePolicy) => Effect.Effect<ReadonlyArray<SnapshotId>, DataMoverError>;
}

export class DataMover extends Context.Tag("@lando/core/DataMover")<DataMover, DataMoverShape>() {}
