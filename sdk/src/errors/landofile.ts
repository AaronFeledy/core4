import { Schema } from "effect";

export class LandofileNotFoundError extends Schema.TaggedError<LandofileNotFoundError>()(
  "LandofileNotFoundError",
  {
    message: Schema.String,
    cwd: Schema.String,
  },
) {}

export class LandofileParseError extends Schema.TaggedError<LandofileParseError>()("LandofileParseError", {
  message: Schema.String,
  filePath: Schema.String,
  line: Schema.UndefinedOr(Schema.Number),
  column: Schema.UndefinedOr(Schema.Number),
  cause: Schema.optional(Schema.Unknown),
}) {}

export class LandofileExpressionParseError extends Schema.TaggedError<LandofileExpressionParseError>()(
  "LandofileExpressionParseError",
  {
    message: Schema.String,
    filePath: Schema.String,
    line: Schema.UndefinedOr(Schema.Number),
    column: Schema.UndefinedOr(Schema.Number),
    expression: Schema.optional(Schema.String),
    remediation: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export class LandofileExpressionForbiddenError extends Schema.TaggedError<LandofileExpressionForbiddenError>()(
  "LandofileExpressionForbiddenError",
  {
    message: Schema.String,
    helper: Schema.String,
    filePath: Schema.optional(Schema.String),
    remediation: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export class LandofileExpressionEvalError extends Schema.TaggedError<LandofileExpressionEvalError>()(
  "LandofileExpressionEvalError",
  {
    message: Schema.String,
    filePath: Schema.optional(Schema.String),
    expression: Schema.optional(Schema.String),
    remediation: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export class LandofileValidationError extends Schema.TaggedError<LandofileValidationError>()(
  "LandofileValidationError",
  {
    message: Schema.String,
    file: Schema.String,
    issues: Schema.Array(Schema.String),
  },
) {}

/**
 * A config write (`app config set/unset/edit`, `meta config set/unset/edit`,
 * `meta global config set/unset/edit`) was rejected because the resulting
 * document failed schema validation or the target path was malformed. The
 * write is aborted with no partial change; `path` names the offending key
 * path (when known) and `remediation` explains how to fix it.
 */
export class LandofileWriteValidationError extends Schema.TaggedError<LandofileWriteValidationError>()(
  "LandofileWriteValidationError",
  {
    message: Schema.String,
    file: Schema.String,
    path: Schema.optional(Schema.String),
    issues: Schema.Array(Schema.String),
    remediation: Schema.String,
  },
) {}

/**
 * Programmatic `.lando.ts` Landofile violated the loader's sandbox policy
 * (forbidden module import, host shell-out, network fetch, or filesystem
 * access outside the app root).
 */
export class LandofileSandboxError extends Schema.TaggedError<LandofileSandboxError>()(
  "LandofileSandboxError",
  {
    message: Schema.String,
    filePath: Schema.String,
    violation: Schema.String,
    remediation: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

/**
 * Programmatic `.lando.ts` Landofile did not produce a value within the
 * configured execution timeout.
 */
export class LandofileTimeoutError extends Schema.TaggedError<LandofileTimeoutError>()(
  "LandofileTimeoutError",
  {
    message: Schema.String,
    filePath: Schema.String,
    timeoutMs: Schema.Number,
    remediation: Schema.String,
  },
) {}

export class LandofileLockMismatchError extends Schema.TaggedError<LandofileLockMismatchError>()(
  "LandofileLockMismatchError",
  {
    message: Schema.String,
    lockfile: Schema.String,
    source: Schema.String,
    expected: Schema.String,
    actual: Schema.String,
    remediation: Schema.String,
  },
) {}

export class LandofileIncludeError extends Schema.TaggedError<LandofileIncludeError>()(
  "LandofileIncludeError",
  {
    message: Schema.String,
    source: Schema.String,
    kind: Schema.Literal(
      "source-unresolved",
      "fetch-failed",
      "parse-failed",
      "forbidden-field",
      "outside-root",
      "cycle",
      "max-depth",
      "subpath-invalid",
    ),
    remediation: Schema.String,
  },
) {}
