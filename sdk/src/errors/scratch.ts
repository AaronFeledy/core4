import { Schema } from "effect";

/**
 * Umbrella error for scratch-app state transitions and path management
 * performed by `ScratchAppService`.
 */
export class ScratchAppError extends Schema.TaggedError<ScratchAppError>()("ScratchAppError", {
  message: Schema.String,
  operation: Schema.optional(Schema.String),
  remediation: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Unknown),
}) {}

export class ScratchSourceUnresolvedError extends Schema.TaggedError<ScratchSourceUnresolvedError>()(
  "ScratchSourceUnresolvedError",
  {
    message: Schema.String,
    source: Schema.String,
    attempts: Schema.Array(Schema.String),
    remediation: Schema.String,
  },
) {}

export class ScratchAppNotFoundError extends Schema.TaggedError<ScratchAppNotFoundError>()(
  "ScratchAppNotFoundError",
  {
    message: Schema.String,
    id: Schema.String,
    suggestions: Schema.Array(Schema.String),
    remediation: Schema.String,
  },
) {}

export class ScratchAppIdInvalidError extends Schema.TaggedError<ScratchAppIdInvalidError>()(
  "ScratchAppIdInvalidError",
  {
    message: Schema.String,
    id: Schema.String,
    remediation: Schema.String,
  },
) {}

export class ScratchIsolationConflictError extends Schema.TaggedError<ScratchIsolationConflictError>()(
  "ScratchIsolationConflictError",
  {
    message: Schema.String,
    flags: Schema.Array(Schema.String),
    remediation: Schema.String,
  },
) {}

/**
 * `apps:scratch:run --service <name>` referenced a service the resolved
 * recipe does not define. Carries the requested service and the services
 * the scratch app actually planned.
 */
export class ScratchRunTargetError extends Schema.TaggedError<ScratchRunTargetError>()(
  "ScratchRunTargetError",
  {
    message: Schema.String,
    service: Schema.String,
    available: Schema.Array(Schema.String),
    remediation: Schema.String,
  },
) {}
