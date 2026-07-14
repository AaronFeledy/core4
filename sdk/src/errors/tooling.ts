import { Schema } from "effect";

export class ToolingCompileError extends Schema.TaggedError<ToolingCompileError>()("ToolingCompileError", {
  message: Schema.String,
  tool: Schema.String,
  remediation: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Unknown),
}) {}

export class ToolingExecError extends Schema.TaggedError<ToolingExecError>()("ToolingExecError", {
  message: Schema.String,
  tool: Schema.String,
  exitCode: Schema.optional(Schema.Number),
  remediation: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Unknown),
}) {}
