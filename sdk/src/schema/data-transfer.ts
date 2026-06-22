import { Schema } from "effect";

import { StorageScope } from "./mounts.ts";
import { AbsolutePath, AppId, CommandSpec, PortablePath, ServiceName } from "./primitives.ts";

/**
 * Archive container format for `hostArchive` endpoints and `copy`-mode volume
 * snapshots.
 */
export const ArchiveFormat = Schema.Literal("tar", "tar.gz", "tar.zst");
export type ArchiveFormat = typeof ArchiveFormat.Type;

/**
 * A byte-movement endpoint. Every `DataMover` operation is a transfer between
 * two of these, or a snapshot/restore over a `volume`.
 */
export const DataEndpoint = Schema.Union(
  Schema.TaggedStruct("hostPath", { path: AbsolutePath }),
  Schema.TaggedStruct("hostArchive", { path: AbsolutePath, format: ArchiveFormat }),
  Schema.TaggedStruct("stream", {}),
  Schema.TaggedStruct("volume", { app: AppId, store: Schema.String }),
  Schema.TaggedStruct("servicePath", { app: AppId, service: ServiceName, path: PortablePath }),
  Schema.TaggedStruct("serviceCmd", { app: AppId, service: ServiceName, command: CommandSpec }),
  Schema.TaggedStruct("artifact", { ref: Schema.String }),
);
export type DataEndpoint = typeof DataEndpoint.Type;

/**
 * Opaque, content+timestamp-derived snapshot identifier.
 */
export const SnapshotId = Schema.String;
export type SnapshotId = typeof SnapshotId.Type;

/**
 * Plain string label map for persisted sidecars and filter criteria.
 */
export const LabelMap = Schema.Record({ key: Schema.String, value: Schema.String });
export type LabelMap = typeof LabelMap.Type;

/**
 * Reference to a named volume (a `DataStorePlan`) owned by an app.
 */
export const VolumeRef = Schema.Struct({
  app: AppId,
  store: Schema.String,
  scope: Schema.optional(StorageScope),
});
export type VolumeRef = typeof VolumeRef.Type;

/**
 * Provider-observed metadata for a named volume.
 */
export const VolumeInfo = Schema.Struct({
  ref: VolumeRef,
  createdAt: Schema.optional(Schema.DateTimeUtc),
  sizeBytes: Schema.optional(Schema.Number),
  labels: Schema.optional(LabelMap),
});
export type VolumeInfo = typeof VolumeInfo.Type;

/**
 * Match criteria for listing volumes.
 */
export const VolumeFilter = Schema.Struct({
  app: Schema.optional(AppId),
  store: Schema.optional(Schema.String),
  scope: Schema.optional(StorageScope),
  labels: Schema.optional(LabelMap),
});
export type VolumeFilter = typeof VolumeFilter.Type;

/**
 * Opaque handle to a provider-native volume snapshot.
 */
export const VolumeSnapshotRef = Schema.Struct({
  provider: Schema.String,
  id: Schema.String,
});
export type VolumeSnapshotRef = typeof VolumeSnapshotRef.Type;

/**
 * Request to snapshot a volume natively.
 */
export const VolumeSnapshotSpec = Schema.Struct({
  volume: VolumeRef,
  snapshotId: Schema.optional(SnapshotId),
  label: Schema.optional(Schema.String),
  labels: Schema.optional(LabelMap),
});
export type VolumeSnapshotSpec = typeof VolumeSnapshotSpec.Type;

/**
 * Request to restore a native snapshot into a target volume.
 */
export const VolumeRestoreSpec = Schema.Struct({
  snapshot: VolumeSnapshotRef,
  target: VolumeRef,
  overwrite: Schema.optional(Schema.Boolean),
});
export type VolumeRestoreSpec = typeof VolumeRestoreSpec.Type;

/**
 * Request to copy a host source into a path inside a service.
 */
export const ServiceCopyInSpec = Schema.Struct({
  sourcePath: AbsolutePath,
  targetPath: PortablePath,
  format: Schema.optional(ArchiveFormat),
  overwrite: Schema.optional(Schema.Boolean),
});
export type ServiceCopyInSpec = typeof ServiceCopyInSpec.Type;

/**
 * Request to stream a path out of a service.
 */
export const ServiceCopyOutSpec = Schema.Struct({
  sourcePath: PortablePath,
  format: Schema.optional(ArchiveFormat),
});
export type ServiceCopyOutSpec = typeof ServiceCopyOutSpec.Type;

/**
 * A single byte-movement request between two endpoints.
 */
export const DataTransferSpec = Schema.Struct({
  from: DataEndpoint,
  to: DataEndpoint,
  overwrite: Schema.optional(Schema.Boolean),
  expectedDigest: Schema.optional(Schema.String),
});
export type DataTransferSpec = typeof DataTransferSpec.Type;

/**
 * Outcome of a completed transfer.
 */
export const DataTransferResult = Schema.Struct({
  accelerated: Schema.Boolean,
  sizeBytes: Schema.optional(Schema.Number),
  digest: Schema.optional(Schema.String),
});
export type DataTransferResult = typeof DataTransferResult.Type;

/**
 * Streaming progress for a transfer in flight.
 */
export const DataTransferProgress = Schema.Struct({
  phase: Schema.Literal("started", "progress", "completed"),
  transferredBytes: Schema.Number,
  totalBytes: Schema.optional(Schema.Number),
  digest: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
});
export type DataTransferProgress = typeof DataTransferProgress.Type;

/**
 * Options for taking a volume snapshot.
 */
export const SnapshotOptions = Schema.Struct({
  format: Schema.optional(ArchiveFormat),
  volumeSnapshot: Schema.optional(Schema.Literal("copy", "native")),
  label: Schema.optional(Schema.String),
  labels: Schema.optional(LabelMap),
});
export type SnapshotOptions = typeof SnapshotOptions.Type;

/**
 * Handle returned by `snapshot`, enough to locate the snapshot sidecar.
 */
export const SnapshotHandle = Schema.Struct({
  id: SnapshotId,
  store: VolumeRef,
});
export type SnapshotHandle = typeof SnapshotHandle.Type;

/**
 * Persisted snapshot sidecar record.
 */
export const SnapshotInfo = Schema.Struct({
  id: SnapshotId,
  store: VolumeRef,
  digest: Schema.String,
  sizeBytes: Schema.Number,
  createdAt: Schema.DateTimeUtc,
  format: Schema.optional(ArchiveFormat),
  label: Schema.optional(Schema.String),
  labels: Schema.optional(LabelMap),
  native: Schema.optional(VolumeSnapshotRef),
});
export type SnapshotInfo = typeof SnapshotInfo.Type;

/**
 * Match criteria for listing snapshots.
 */
export const SnapshotFilter = Schema.Struct({
  id: Schema.optional(SnapshotId),
  app: Schema.optional(AppId),
  store: Schema.optional(Schema.String),
  scope: Schema.optional(StorageScope),
  label: Schema.optional(Schema.String),
  labels: Schema.optional(LabelMap),
  createdAfter: Schema.optional(Schema.DateTimeUtc),
  createdBefore: Schema.optional(Schema.DateTimeUtc),
});
export type SnapshotFilter = typeof SnapshotFilter.Type;

/**
 * Retention policy for pruning snapshots.
 */
export const PrunePolicy = Schema.Struct({
  filter: Schema.optional(SnapshotFilter),
  keepLatest: Schema.optional(Schema.Number),
});
export type PrunePolicy = typeof PrunePolicy.Type;
