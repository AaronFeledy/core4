import { Schema } from "effect";

import { AppPlan } from "./app-plan.ts";
import { DataEndpoint, SnapshotHandle, VolumeRef } from "./data-transfer.ts";
import { AppId, PortablePath, ServiceName } from "./primitives.ts";

export const RemoteEnvId = Schema.String;
export type RemoteEnvId = typeof RemoteEnvId.Type;

export const DatasetKind = Schema.Literals(["database", "files", "config", "blob"]);
export type DatasetKind = typeof DatasetKind.Type;

export const RemoteCapabilities = Schema.Struct({
  environments: Schema.Boolean,
  push: Schema.Boolean,
  datasets: Schema.Array(DatasetKind),
  tool: Schema.optionalKey(Schema.String),
  auth: Schema.optionalKey(Schema.Literals(["none", "token", "oauth", "basic", "ssh", "custom"])),
  protectedByDefault: Schema.optionalKey(Schema.Array(RemoteEnvId)),
});
export type RemoteCapabilities = typeof RemoteCapabilities.Type;

export const RemoteConfig = Schema.Struct({
    source: Schema.String,
  }).pipe((self) => Schema.StructWithRest(self, [Schema.Record(Schema.String, Schema.Unknown)]));
export type RemoteConfig = typeof RemoteConfig.Type;

export const DatasetBinding = Schema.Struct({
  service: Schema.optionalKey(ServiceName),
  path: Schema.optionalKey(PortablePath),
});
export type DatasetBinding = typeof DatasetBinding.Type;

export const RemoteEnvironment = Schema.Struct({
  id: RemoteEnvId,
  label: Schema.optionalKey(Schema.String),
  protected: Schema.optionalKey(Schema.Boolean),
  default: Schema.optionalKey(Schema.Boolean),
  datasets: Schema.optionalKey(Schema.Array(DatasetKind)),
});
export type RemoteEnvironment = typeof RemoteEnvironment.Type;

export const RemoteLocator = Schema.Struct({
  remote: Schema.String,
  env: RemoteEnvId,
  dataset: DatasetKind,
  endpoint: Schema.optionalKey(Schema.String),
  metadata: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});
export type RemoteLocator = typeof RemoteLocator.Type;

export const RemoteFetchOptions = Schema.Struct({
  force: Schema.optionalKey(Schema.Boolean),
  expectedDigest: Schema.optionalKey(Schema.String),
});
export type RemoteFetchOptions = typeof RemoteFetchOptions.Type;

export const RemoteSendOptions = Schema.Struct({
  force: Schema.optionalKey(Schema.Boolean),
  protectedEnvConfirmed: Schema.optionalKey(Schema.Boolean),
  expectedDigest: Schema.optionalKey(Schema.String),
});
export type RemoteSendOptions = typeof RemoteSendOptions.Type;

export const RemoteTestResult = Schema.Struct({
  ok: Schema.Boolean,
  env: Schema.optionalKey(RemoteEnvId),
  message: Schema.optionalKey(Schema.String),
  remediation: Schema.optionalKey(Schema.String),
});
export type RemoteTestResult = typeof RemoteTestResult.Type;

export const DatasetCapabilities = Schema.Struct({
  capture: Schema.Boolean,
  apply: Schema.Boolean,
  localStore: Schema.optionalKey(Schema.Boolean),
  destructiveApply: Schema.optionalKey(Schema.Boolean),
});
export type DatasetCapabilities = typeof DatasetCapabilities.Type;

export const DatasetArtifactFormat = Schema.Struct({
  endpoint: Schema.Literals(["stream", "hostArchive"]),
  mediaType: Schema.optionalKey(Schema.String),
  archiveFormat: Schema.optionalKey(Schema.Literals(["tar", "tar.gz", "tar.zst"])),
});
export type DatasetArtifactFormat = typeof DatasetArtifactFormat.Type;

export const DatasetContext = Schema.Struct({
  app: AppId,
  plan: AppPlan,
  service: Schema.optionalKey(ServiceName),
  creds: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  binding: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});
export type DatasetContext = typeof DatasetContext.Type;

export const DatasetCaptureOptions = Schema.Struct({
  format: Schema.optionalKey(DatasetArtifactFormat),
  includeMetadata: Schema.optionalKey(Schema.Boolean),
});
export type DatasetCaptureOptions = typeof DatasetCaptureOptions.Type;

export const DatasetApplyOptions = Schema.Struct({
  force: Schema.optionalKey(Schema.Boolean),
  snapshot: Schema.optionalKey(Schema.Boolean),
  expectedDigest: Schema.optionalKey(Schema.String),
});
export type DatasetApplyOptions = typeof DatasetApplyOptions.Type;

export const DatasetApplyResult = Schema.Struct({
  changed: Schema.Boolean,
  localStore: Schema.optionalKey(Schema.Union([VolumeRef, Schema.Null])),
  snapshot: Schema.optionalKey(SnapshotHandle),
  summary: Schema.optionalKey(Schema.String),
});
export type DatasetApplyResult = typeof DatasetApplyResult.Type;

export const SyncResult = Schema.Struct({
  direction: Schema.Literals(["pull", "push"]),
  remote: Schema.String,
  env: RemoteEnvId,
  datasets: Schema.Array(DatasetKind),
  changed: Schema.Boolean,
  artifacts: Schema.optionalKey(Schema.Array(DataEndpoint)),
  snapshots: Schema.optionalKey(Schema.Array(SnapshotHandle)),
  summary: Schema.optionalKey(Schema.String),
});
export type SyncResult = typeof SyncResult.Type;

export const RemoteSourceContribution = Schema.Struct({
  id: Schema.String,
  module: Schema.String,
  capabilities: RemoteCapabilities,
  enabledByDefault: Schema.optionalKey(Schema.Boolean),
  summary: Schema.optionalKey(Schema.String),
});
export type RemoteSourceContribution = typeof RemoteSourceContribution.Type;

export const DatasetContribution = Schema.Struct({
  id: Schema.String,
  module: Schema.String,
  kind: DatasetKind,
  capabilities: Schema.optionalKey(DatasetCapabilities),
  enabledByDefault: Schema.optionalKey(Schema.Boolean),
  summary: Schema.optionalKey(Schema.String),
});
export type DatasetContribution = typeof DatasetContribution.Type;
