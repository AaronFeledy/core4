import { Schema } from "effect";

import { AppPlan } from "./app-plan.ts";
import { DataEndpoint, SnapshotHandle, VolumeRef } from "./data-transfer.ts";
import { AppId, ServiceName } from "./primitives.ts";

export const RemoteEnvId = Schema.String;
export type RemoteEnvId = typeof RemoteEnvId.Type;

export const DatasetKind = Schema.Literal("database", "files", "config", "blob");
export type DatasetKind = typeof DatasetKind.Type;

export const RemoteCapabilities = Schema.Struct({
  environments: Schema.Boolean,
  push: Schema.Boolean,
  datasets: Schema.Array(DatasetKind),
  tool: Schema.optional(Schema.String),
  auth: Schema.optional(Schema.Literal("none", "token", "oauth", "basic", "ssh", "custom")),
  protectedByDefault: Schema.optional(Schema.Array(RemoteEnvId)),
});
export type RemoteCapabilities = typeof RemoteCapabilities.Type;

export const RemoteConfig = Schema.asSchema(
  Schema.Struct({
    source: Schema.String,
  }).pipe(Schema.extend(Schema.Record({ key: Schema.String, value: Schema.Unknown }))),
);
export type RemoteConfig = typeof RemoteConfig.Type;

export const RemoteEnvironment = Schema.Struct({
  id: RemoteEnvId,
  label: Schema.optional(Schema.String),
  protected: Schema.optional(Schema.Boolean),
  default: Schema.optional(Schema.Boolean),
  datasets: Schema.optional(Schema.Array(DatasetKind)),
});
export type RemoteEnvironment = typeof RemoteEnvironment.Type;

export const RemoteLocator = Schema.Struct({
  remote: Schema.String,
  env: RemoteEnvId,
  dataset: DatasetKind,
  endpoint: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
});
export type RemoteLocator = typeof RemoteLocator.Type;

export const RemoteFetchOptions = Schema.Struct({
  force: Schema.optional(Schema.Boolean),
  expectedDigest: Schema.optional(Schema.String),
});
export type RemoteFetchOptions = typeof RemoteFetchOptions.Type;

export const RemoteSendOptions = Schema.Struct({
  force: Schema.optional(Schema.Boolean),
  protectedEnvConfirmed: Schema.optional(Schema.Boolean),
  expectedDigest: Schema.optional(Schema.String),
});
export type RemoteSendOptions = typeof RemoteSendOptions.Type;

export const RemoteTestResult = Schema.Struct({
  ok: Schema.Boolean,
  env: Schema.optional(RemoteEnvId),
  message: Schema.optional(Schema.String),
  remediation: Schema.optional(Schema.String),
});
export type RemoteTestResult = typeof RemoteTestResult.Type;

export const DatasetCapabilities = Schema.Struct({
  capture: Schema.Boolean,
  apply: Schema.Boolean,
  localStore: Schema.optional(Schema.Boolean),
  destructiveApply: Schema.optional(Schema.Boolean),
});
export type DatasetCapabilities = typeof DatasetCapabilities.Type;

export const DatasetArtifactFormat = Schema.Struct({
  endpoint: Schema.Literal("stream", "hostArchive"),
  mediaType: Schema.optional(Schema.String),
  archiveFormat: Schema.optional(Schema.Literal("tar", "tar.gz", "tar.zst")),
});
export type DatasetArtifactFormat = typeof DatasetArtifactFormat.Type;

export const DatasetContext = Schema.Struct({
  app: AppId,
  plan: AppPlan,
  service: Schema.optional(ServiceName),
  creds: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
  binding: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
});
export type DatasetContext = typeof DatasetContext.Type;

export const DatasetCaptureOptions = Schema.Struct({
  format: Schema.optional(DatasetArtifactFormat),
  includeMetadata: Schema.optional(Schema.Boolean),
});
export type DatasetCaptureOptions = typeof DatasetCaptureOptions.Type;

export const DatasetApplyOptions = Schema.Struct({
  force: Schema.optional(Schema.Boolean),
  snapshot: Schema.optional(Schema.Boolean),
  expectedDigest: Schema.optional(Schema.String),
});
export type DatasetApplyOptions = typeof DatasetApplyOptions.Type;

export const DatasetApplyResult = Schema.Struct({
  changed: Schema.Boolean,
  localStore: Schema.optional(Schema.Union(VolumeRef, Schema.Null)),
  snapshot: Schema.optional(SnapshotHandle),
  summary: Schema.optional(Schema.String),
});
export type DatasetApplyResult = typeof DatasetApplyResult.Type;

export const SyncResult = Schema.Struct({
  direction: Schema.Literal("pull", "push"),
  remote: Schema.String,
  env: RemoteEnvId,
  datasets: Schema.Array(DatasetKind),
  changed: Schema.Boolean,
  artifacts: Schema.optional(Schema.Array(DataEndpoint)),
  snapshots: Schema.optional(Schema.Array(SnapshotHandle)),
  summary: Schema.optional(Schema.String),
});
export type SyncResult = typeof SyncResult.Type;

export const RemoteSourceContribution = Schema.Struct({
  id: Schema.String,
  module: Schema.String,
  capabilities: RemoteCapabilities,
  enabledByDefault: Schema.optional(Schema.Boolean),
  summary: Schema.optional(Schema.String),
});
export type RemoteSourceContribution = typeof RemoteSourceContribution.Type;

export const DatasetContribution = Schema.Struct({
  id: Schema.String,
  module: Schema.String,
  kind: DatasetKind,
  capabilities: Schema.optional(DatasetCapabilities),
  enabledByDefault: Schema.optional(Schema.Boolean),
  summary: Schema.optional(Schema.String),
});
export type DatasetContribution = typeof DatasetContribution.Type;
