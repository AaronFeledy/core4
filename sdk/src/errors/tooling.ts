import { Effect, Schema } from "effect";
import { ValidationIssue } from "../schema/validation-issue.ts";

export class ToolingCompileError extends Schema.TaggedError<ToolingCompileError>()("ToolingCompileError", {
  message: Schema.String.annotate({ description: "Human-readable tooling compilation failure." }),
  tool: Schema.String.annotate({ description: "Tooling task identity." }),
  source: Schema.optional(
    Schema.Struct({
      path: Schema.String.annotate({ description: "Known source file for this task." }),
      task: Schema.String.annotate({ description: "Task name within the source." }),
    }),
  ).annotate({ description: "Task source identity, when known." }),
  issues: Schema.Array(ValidationIssue)
    .pipe(Schema.withConstructorDefault(Effect.succeed([])))
    .annotate({
      description:
        "Structured findings with effective paths; empty for failures without declaration findings.",
    }),
  omittedIssueCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
    .pipe(Schema.withConstructorDefault(Effect.succeed(0)))
    .annotate({ description: "Number of additional findings omitted by bounded disclosure." }),
  remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u))
    .pipe(
      Schema.withConstructorDefault(
        Effect.succeed("Correct the tooling task definition and retry the command."),
      ),
    )
    .annotate({ description: "Corrective action for the tooling failure." }),
  cause: Schema.optional(Schema.Unknown).annotate({
    description: "Internal cause; excluded from disclosed diagnostics.",
  }),
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
  variable: Schema.optional(Schema.String),
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
