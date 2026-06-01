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

export class LandofileValidationError extends Schema.TaggedError<LandofileValidationError>()(
  "LandofileValidationError",
  {
    message: Schema.String,
    file: Schema.String,
    issues: Schema.Array(Schema.String),
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
