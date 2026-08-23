import { Schema } from "effect";

export const DbCommandStep = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  target: Schema.String,
  destructive: Schema.Boolean,
});
export type DbCommandStep = typeof DbCommandStep.Type;

export const DbCommandResult = Schema.Struct({
  service: Schema.String,
  family: Schema.optional(Schema.String),
  file: Schema.optional(Schema.String),
  snapshotId: Schema.optional(Schema.String),
  accelerated: Schema.optional(Schema.Boolean),
  sizeBytes: Schema.optional(Schema.Number),
  steps: Schema.Array(DbCommandStep),
});
export type DbCommandResult = typeof DbCommandResult.Type;
