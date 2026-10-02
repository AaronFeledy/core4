import { Schema } from "effect";

import { StorageScope } from "./mounts.ts";
import { AbsolutePath, AppId, CommandSpec, PortablePath, ServiceName } from "./primitives.ts";
import { VolumeIdentity } from "./volume-identity.ts";

/**
 * Archive container format for `hostArchive` endpoints and `copy`-mode volume
 * snapshots.
 */
export const ArchiveFormat = Schema.Literals(["tar", "tar.gz", "tar.zst"]);
export type ArchiveFormat = typeof ArchiveFormat.Type;

/**
 * A byte-movement endpoint. Every `DataMover` operation is a transfer between
 * two of these, or a snapshot/restore over a `volume`.
 */
export const DataEndpoint = Schema.Union([Schema.TaggedStruct("hostPath", {
    path: AbsolutePath,
    trusted: Schema.optionalKey(Schema.Boolean),
  }), Schema.TaggedStruct("hostArchive", { path: AbsolutePath, format: ArchiveFormat }), Schema.TaggedStruct("stream", {}), Schema.TaggedStruct("volume", { app: AppId, store: Schema.String }), Schema.TaggedStruct("servicePath", { app: AppId, service: ServiceName, path: PortablePath }), Schema.TaggedStruct("serviceCmd", {
    app: AppId,
    service: ServiceName,
    command: CommandSpec,
    env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  }), Schema.TaggedStruct("artifact", { ref: Schema.String })]);
export type DataEndpoint = typeof DataEndpoint.Type;

/**
 * Opaque, content+timestamp-derived snapshot identifier.
 */
export const SnapshotId = Schema.String;
export type SnapshotId = typeof SnapshotId.Type;

/**
 * Plain string label map for persisted sidecars and filter criteria.
 */
export const LabelMap = Schema.Record(Schema.String, Schema.String);
export type LabelMap = typeof LabelMap.Type;

/**
 * Reference to a named volume (a `DataStorePlan`) owned by an app.
 */
export const VolumeRef = Schema.Struct({
  app: AppId,
  store: Schema.String,
  scope: Schema.optionalKey(StorageScope),
});
export type VolumeRef = typeof VolumeRef.Type;

/** Stable provider locator for one native volume, available before creation. */
export const VolumeLocator = Schema.Struct({
  coordinationKey: Schema.NonEmptyString.annotate({
    description: "Opaque configured-endpoint and native-volume key, stable across recreation.",
  }),
  nativeName: Schema.NonEmptyString.annotate({ description: "Provider-native volume name." }),
  identity: Schema.optionalKey(VolumeIdentity).annotate({
    description: "Observed generation and owner when the volume currently exists with provenance.",
  }),
});
export type VolumeLocator = typeof VolumeLocator.Type;

/**
 * Provider-observed metadata for a named volume.
 */
export const VolumeInfo = Schema.Struct({
  ref: VolumeRef,
  identity: Schema.optionalKey(VolumeIdentity).annotate({
    description: "Owner-bound physical identity; absent facts must not authorize physical recovery.",
  }),
  instanceId: Schema.optionalKey(Schema.String).annotate({
    description: "Provider-observed identity for this physical volume creation.",
  }),
  provenance: Schema.optionalKey(Schema.Literals(["known", "legacy"])).annotate({
    description: "Whether the provider can prove this volume creation's identity.",
  }),
  createdAt: Schema.optionalKey(Schema.DateTimeUtc),
  sizeBytes: Schema.optionalKey(Schema.Number),
  labels: Schema.optionalKey(LabelMap),
});
export type VolumeInfo = typeof VolumeInfo.Type;

/**
 * Match criteria for listing volumes.
 */
export const VolumeFilter = Schema.Struct({
  app: Schema.optionalKey(AppId),
  store: Schema.optionalKey(Schema.String),
  scope: Schema.optionalKey(StorageScope),
  labels: Schema.optionalKey(LabelMap),
});
export type VolumeFilter = typeof VolumeFilter.Type;

/**
 * Opaque handle to a provider-native volume snapshot.
 */
export const VolumeSnapshotRef = Schema.Struct({
  provider: Schema.String,
  id: Schema.String,
  digest: Schema.String.annotate({
    description: "SHA-256 digest or provider-observed immutable artifact identity.",
  }),
  sizeBytes: Schema.Number.annotate({ description: "Provider-observed immutable artifact size." }),
  format: Schema.Literals(["tar", "native"]).annotate({
    description: "Immutable artifact format used by the provider snapshot.",
  }),
});
export type VolumeSnapshotRef = typeof VolumeSnapshotRef.Type;

/**
 * Request to snapshot a volume natively.
 */
export const VolumeSnapshotSpec = Schema.Struct({
  volume: VolumeRef,
  snapshotId: Schema.optionalKey(SnapshotId),
  label: Schema.optionalKey(Schema.String),
  labels: Schema.optionalKey(LabelMap),
});
export type VolumeSnapshotSpec = typeof VolumeSnapshotSpec.Type;

/**
 * Request to restore a native snapshot into a target volume.
 */
export const VolumeRestoreSpec = Schema.Struct({
  snapshot: VolumeSnapshotRef,
  target: VolumeRef,
  expectedTargetGeneration: VolumeIdentity.fields.generation,
  overwrite: Schema.optionalKey(Schema.Boolean),
});
export type VolumeRestoreSpec = typeof VolumeRestoreSpec.Type;

/**
 * Request to copy a host source into a path inside a service.
 */
export const ServiceCopyInSpec = Schema.Struct({
  sourcePath: AbsolutePath,
  targetPath: PortablePath,
  format: Schema.optionalKey(ArchiveFormat),
  overwrite: Schema.optionalKey(Schema.Boolean),
});
export type ServiceCopyInSpec = typeof ServiceCopyInSpec.Type;

/**
 * Request to stream a path out of a service.
 */
export const ServiceCopyOutSpec = Schema.Struct({
  sourcePath: PortablePath,
  format: Schema.optionalKey(ArchiveFormat),
});
export type ServiceCopyOutSpec = typeof ServiceCopyOutSpec.Type;

/**
 * A single byte-movement request between two endpoints.
 */
export const DataTransferSpec = Schema.Struct({
  from: DataEndpoint,
  to: DataEndpoint,
  overwrite: Schema.optionalKey(Schema.Boolean),
  expectedDigest: Schema.optionalKey(Schema.String),
});
export type DataTransferSpec = typeof DataTransferSpec.Type;

/**
 * Outcome of a completed transfer.
 */
export const DataTransferResult = Schema.Struct({
  accelerated: Schema.Boolean,
  sizeBytes: Schema.optionalKey(Schema.Number),
  digest: Schema.optionalKey(Schema.String),
});
export type DataTransferResult = typeof DataTransferResult.Type;

/**
 * Streaming progress for a transfer in flight.
 */
export const DataTransferProgress = Schema.Struct({
  phase: Schema.Literals(["started", "progress", "completed"]),
  transferredBytes: Schema.Number,
  totalBytes: Schema.optionalKey(Schema.Number),
  digest: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String),
});
export type DataTransferProgress = typeof DataTransferProgress.Type;

export const SnapshotMetadata = Schema.Struct({
  sourceRoot: AbsolutePath.annotate({ description: "Canonical app root that owns the snapshot." }),
  ownerKey: Schema.optionalKey(Schema.String).annotate({
    description: "Stable owner identity derived from the canonical app root.",
  }),
  repoGroupKey: Schema.optionalKey(Schema.String).annotate({
    description: "Stable identity shared by snapshots from sibling Git worktrees.",
  }),
  service: ServiceName.annotate({ description: "Database service captured by the snapshot." }),
  volumeInstanceId: Schema.String.annotate({
    description: "Physical source volume creation identity.",
  }),
  family: Schema.String.annotate({ description: "Observed database family." }),
  version: Schema.String.annotate({ description: "Observed database version." }),
  imageIdentity: Schema.String.annotate({ description: "Observed immutable runtime image identity." }),
  recoveryReason: Schema.Literals(["manual", "reset", "restore", "import", "seed"]).annotate({
    description: "Reason this durable recovery point was created.",
  }),
});
export type SnapshotMetadata = typeof SnapshotMetadata.Type;

/**
 * Options for taking a volume snapshot.
 */
export const SnapshotOptions = Schema.Struct({
  format: Schema.optionalKey(ArchiveFormat),
  volumeSnapshot: Schema.optionalKey(Schema.Literals(["copy", "native"])),
  label: Schema.optionalKey(Schema.String),
  labels: Schema.optionalKey(LabelMap),
  metadata: Schema.optionalKey(SnapshotMetadata).annotate({
    description: "Physical ownership and database compatibility metadata supplied by the caller.",
  }),
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
  format: Schema.optionalKey(ArchiveFormat),
  label: Schema.optionalKey(Schema.String),
  labels: Schema.optionalKey(LabelMap),
  native: Schema.optionalKey(VolumeSnapshotRef),
  metadata: Schema.optionalKey(SnapshotMetadata).annotate({
    description: "Physical ownership and database compatibility metadata recorded at creation.",
  }),
});
export type SnapshotInfo = typeof SnapshotInfo.Type;

/**
 * Match criteria for listing snapshots.
 */
export const SnapshotFilter = Schema.Struct({
  id: Schema.optionalKey(SnapshotId),
  app: Schema.optionalKey(AppId),
  store: Schema.optionalKey(Schema.String),
  sourceRoot: Schema.optionalKey(AbsolutePath).annotate({ description: "Canonical source app root." }),
  ownerKey: Schema.optionalKey(Schema.String).annotate({ description: "Canonical source owner identity." }),
  repoGroupKey: Schema.optionalKey(Schema.String).annotate({
    description: "Git worktree group identity shared by eligible sources.",
  }),
  service: Schema.optionalKey(ServiceName).annotate({
    description: "Database service captured by the snapshot.",
  }),
  scope: Schema.optionalKey(StorageScope),
  label: Schema.optionalKey(Schema.String),
  labels: Schema.optionalKey(LabelMap),
  createdAfter: Schema.optionalKey(Schema.DateTimeUtc),
  createdBefore: Schema.optionalKey(Schema.DateTimeUtc),
});
export type SnapshotFilter = typeof SnapshotFilter.Type;

/**
 * Retention policy for pruning snapshots.
 */
export const PrunePolicy = Schema.Struct({
  filter: Schema.optionalKey(SnapshotFilter),
  keepLatest: Schema.optionalKey(Schema.Number),
});
export type PrunePolicy = typeof PrunePolicy.Type;
