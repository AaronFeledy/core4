import { Schema } from "effect";

export class ToolingCompileError extends Schema.TaggedError<ToolingCompileError>()("ToolingCompileError", {
  message: Schema.String,
  tool: Schema.String,
  remediation: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Unknown),
}) {}

export class ToolingIncludeCycleError extends Schema.TaggedError<ToolingIncludeCycleError>()(
  "ToolingIncludeCycleError",
  {
    message: Schema.String,
    source: Schema.String,
    remediation: Schema.String,
  },
) {}

export class ToolingExecError extends Schema.TaggedError<ToolingExecError>()("ToolingExecError", {
  message: Schema.String,
  tool: Schema.String,
  exitCode: Schema.optional(Schema.Number),
  remediation: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Unknown),
}) {}

/**
 * A `command:` step's canonical id did not resolve to a registered built-in,
 * plugin-contributed, or tooling command at compile time. Remediation SHOULD
 * list close matches when available.
 */
export class ToolingCommandLookupError extends Schema.TaggedError<ToolingCommandLookupError>()(
  "ToolingCommandLookupError",
  {
    message: Schema.String,
    /** Canonical id that failed lookup. */
    target: Schema.String,
    /** Which registry family the lookup was attempting. */
    targetKind: Schema.Literal("built-in", "plugin", "tooling"),
    remediation: Schema.String,
    pluginId: Schema.optional(Schema.String),
    commandId: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Unknown),
  },
) {}
