import { Schema } from "effect";

export class ProcessExecError extends Schema.TaggedError<ProcessExecError>()("ProcessExecError", {
  message: Schema.String,
  cmd: Schema.String,
  cwd: Schema.optional(Schema.String),
  errno: Schema.optional(Schema.Number),
  cause: Schema.optional(Schema.Unknown),
}) {}

export class ProcessTimeoutError extends Schema.TaggedError<ProcessTimeoutError>()("ProcessTimeoutError", {
  message: Schema.String,
  cmd: Schema.String,
  cwd: Schema.optional(Schema.String),
  elapsedMs: Schema.Number,
}) {}
