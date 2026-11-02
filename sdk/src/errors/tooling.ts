import { Effect, Schema } from "effect";

export class ToolingCompileError extends Schema.TaggedError<ToolingCompileError>()("ToolingCompileError", {
  message: Schema.String,
  tool: Schema.String,
  source: Schema.optional(Schema.Struct({ path: Schema.String, task: Schema.String })),
  remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)).pipe(
    Schema.withConstructorDefault(
      Effect.succeed(
        "Correct the tooling task definition and run `lando app:cache:refresh` before retrying.",
      ),
    ),
  ),
  cause: Schema.optional(Schema.Unknown),
}) {}

export class ToolingInputError extends Schema.TaggedError<ToolingInputError>()("ToolingInputError", {
  message: Schema.String,
  tool: Schema.String,
  field: Schema.optional(Schema.String),
  source: Schema.optional(Schema.Struct({ path: Schema.String, task: Schema.String })),
  remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)),
}) {}

export class ToolingDisabledError extends Schema.TaggedError<ToolingDisabledError>()("ToolingDisabledError", {
  message: Schema.String,
  tool: Schema.String,
  source: Schema.Struct({ path: Schema.String, task: Schema.String }),
  remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)),
}) {}

export class ToolingExecError extends Schema.TaggedError<ToolingExecError>()("ToolingExecError", {
  message: Schema.String,
  tool: Schema.String,
  exitCode: Schema.optional(Schema.Number),
  remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)),
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
    targetKind: Schema.Literals(["built-in", "plugin", "tooling"]),
    remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)),
    pluginId: Schema.optional(Schema.String),
    commandId: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Unknown),
  },
) {}
