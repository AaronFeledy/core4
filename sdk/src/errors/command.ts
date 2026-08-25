import { Schema } from "effect";

/**
 * A plugin- or tooling-contributed top-level alias collides with a reserved
 * built-in top-level alias (for example the bare `run` alias reserved for
 * `apps:scratch:run`, or the `scratch`/`scratch:*` aliases reserved for
 * `apps:scratch:*`). Raised at command registration, plan time for surviving
 * service-type tooling names, or tooling invocation; user
 * `commandAliases.custom:` overrides are the sanctioned remap path.
 */
export class CommandAliasConflictError extends Schema.TaggedError<CommandAliasConflictError>()(
  "CommandAliasConflictError",
  {
    message: Schema.String,
    /** The top-level alias that was claimed. */
    alias: Schema.String,
    /** What tried to claim the alias (a command id, tooling task, or plugin). */
    claimedBy: Schema.String,
    /** Canonical built-in command id the alias is reserved for. */
    reservedFor: Schema.String,
    remediation: Schema.String,
  },
) {}

/** A per-app custom alias points at no registered built-in or cached app command. */
export class CommandAliasTargetError extends Schema.TaggedError<CommandAliasTargetError>()(
  "CommandAliasTargetError",
  {
    message: Schema.String,
    alias: Schema.String,
    target: Schema.String,
    closeMatches: Schema.Array(Schema.String),
    remediation: Schema.String,
  },
) {}

/**
 * A `command:` step's `flags`, `args`, or `raw` failed validation against the
 * target command's `LandoCommandSpec` at compile time (literals) or invocation
 * time (expression-resolved values).
 */
export class CommandInputValidationError extends Schema.TaggedError<CommandInputValidationError>()(
  "CommandInputValidationError",
  {
    message: Schema.String,
    /** Canonical id of the target command. */
    target: Schema.String,
    /** Offending flag or arg key. */
    field: Schema.String,
    kind: Schema.Literal("flag", "arg"),
    /** Machine-readable validation reason (e.g. unknown, required, type). */
    reason: Schema.String,
    remediation: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

/**
 * `--json key1,key2` projection failed against a command result.
 */
export class JsonProjectionError extends Schema.TaggedError<JsonProjectionError>()(
  "JsonProjectionError",
  {
    message: Schema.String,
    /** Canonical command id when the projection is command-scoped. */
    command: Schema.optional(Schema.String),
    keys: Schema.Array(Schema.String),
    available: Schema.Array(Schema.String),
    reason: Schema.Literal("unknown_key", "duplicate_key", "non_object_result", "format_conflict"),
    remediation: Schema.String,
  },
) {}

/** `--jq` cannot be combined with bare `--json`. */
export class JsonJqConflictError extends Schema.TaggedError<JsonJqConflictError>()(
  "JsonJqConflictError",
  {
    message: Schema.String,
    remediation: Schema.String,
  },
) {}

/** A `--jq` expression failed to evaluate, timed out, or exceeded size limits. */
export class JqExpressionError extends Schema.TaggedError<JqExpressionError>()(
  "JqExpressionError",
  {
    message: Schema.String,
    expression: Schema.String,
    reason: Schema.Literal("eval", "timeout", "too_large", "missing_value"),
    remediation: Schema.String,
    detail: Schema.optional(Schema.String),
  },
) {}
