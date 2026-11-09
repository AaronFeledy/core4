import { AbsolutePath, AppId, ProviderId } from "@lando/sdk/schema";
import { Schema } from "effect";
import { PendingStart } from "./accelerated-start-record.ts";

export const MissingAppRoot = Schema.Struct({
  root: AbsolutePath,
  apps: Schema.Array(AppId),
  providers: Schema.Array(ProviderId),
  appliedState: Schema.Boolean,
  runtimeObserved: Schema.Boolean,
  fileSyncCopiesRemovable: Schema.Boolean,
  services: Schema.Array(Schema.String),
  dataVolumes: Schema.Array(Schema.String),
  cacheVolumes: Schema.Array(Schema.String),
  journals: Schema.Array(PendingStart),
});
export type MissingAppRoot = typeof MissingAppRoot.Type;

export const MissingRootScan = Schema.Struct({
  providerId: ProviderId,
  runtimeObserved: Schema.Boolean,
  recordedState: Schema.Boolean,
  message: Schema.String,
  complete: Schema.Boolean,
  errorTag: Schema.optionalKey(Schema.String),
  remediation: Schema.optionalKey(Schema.String),
});
