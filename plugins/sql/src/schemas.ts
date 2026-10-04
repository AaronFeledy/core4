import { Schema } from "effect";

import { SnapshotId, SnapshotInfo } from "@lando/sdk/schema";

export const DbCommandStep = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  target: Schema.String,
  destructive: Schema.Boolean,
});
export type DbCommandStep = typeof DbCommandStep.Type;

export const DbCommandResult = Schema.Struct({
  service: Schema.String,
  family: Schema.optionalKey(Schema.String),
  file: Schema.optionalKey(Schema.String),
  snapshotId: Schema.optionalKey(Schema.String),
  snapshots: Schema.optionalKey(Schema.Array(SnapshotInfo)),
  pruneCandidates: Schema.optionalKey(Schema.Array(SnapshotId)),
  prunedSnapshotIds: Schema.optionalKey(Schema.Array(SnapshotId)),
  retentionApplied: Schema.optionalKey(Schema.Boolean),
  seedStatus: Schema.optionalKey(Schema.Literal("seeded")),
  accelerated: Schema.optionalKey(Schema.Boolean),
  sizeBytes: Schema.optionalKey(Schema.Number),
  steps: Schema.Array(DbCommandStep),
});
export type DbCommandResult = typeof DbCommandResult.Type;
