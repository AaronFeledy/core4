import { Schema } from "effect";

export class GlobalServiceCapabilityError extends Schema.TaggedError<GlobalServiceCapabilityError>()(
  "GlobalServiceCapabilityError",
  {
    message: Schema.String,
    id: Schema.String,
    plugin: Schema.optional(Schema.String),
    missing: Schema.Array(Schema.String),
    providerId: Schema.String,
    remediation: Schema.String,
  },
) {}

export class GlobalServiceCollisionError extends Schema.TaggedError<GlobalServiceCollisionError>()(
  "GlobalServiceCollisionError",
  {
    message: Schema.String,
    id: Schema.String,
    plugins: Schema.Array(Schema.String),
    remediation: Schema.String,
  },
) {}

/**
 * A user-authored Landofile declared (or resolved to) the reserved app id
 * `global`, which is owned by the global Lando app. Raised during user-app
 * resolution before any plan is built.
 */
export class AppIdReservedError extends Schema.TaggedError<AppIdReservedError>()("AppIdReservedError", {
  reserved: Schema.String,
  suggested: Schema.optional(Schema.String),
}) {}

/**
 * Umbrella error for global-app state transitions and path management
 * performed by `GlobalAppService`.
 */
export class GlobalAppError extends Schema.TaggedError<GlobalAppError>()("GlobalAppError", {
  message: Schema.String,
  operation: Schema.optional(Schema.String),
  remediation: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Unknown),
}) {}

/**
 * A user app's start required a global service that is not present in the
 * resolved global app plan (its contributing plugin is not installed, the
 * service is disabled, or its provider capability requirements were not met).
 * Raised by the auto-start integration during a user app's `start`.
 */
export class GlobalServiceMissingError extends Schema.TaggedError<GlobalServiceMissingError>()(
  "GlobalServiceMissingError",
  {
    message: Schema.String,
    requested: Schema.Array(Schema.String),
    available: Schema.Array(Schema.String),
    remediation: Schema.optional(Schema.String),
  },
) {}

/**
 * The global Lando app failed to auto-start while bringing up a user app that
 * declared a dependency on one or more global services. Chains the underlying
 * global-app failure in `cause` so the user-app start error points at the real
 * root cause.
 */
export class GlobalAutoStartError extends Schema.TaggedError<GlobalAutoStartError>()("GlobalAutoStartError", {
  message: Schema.String,
  app: Schema.String,
  services: Schema.Array(Schema.String),
  remediation: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Unknown),
}) {}

export class GlobalDestroyConfirmationError extends Schema.TaggedError<GlobalDestroyConfirmationError>()(
  "GlobalDestroyConfirmationError",
  {
    message: Schema.String,
    remediation: Schema.String,
  },
) {}

export class GlobalDistConflictError extends Schema.TaggedError<GlobalDistConflictError>()(
  "GlobalDistConflictError",
  {
    message: Schema.String,
    path: Schema.String,
    reason: Schema.Literal("foreign-file", "manual-edit"),
    remediation: Schema.String,
  },
) {}

export class GlobalLandofilePathConflictError extends Schema.TaggedError<GlobalLandofilePathConflictError>()(
  "GlobalLandofilePathConflictError",
  {
    message: Schema.String,
    path: Schema.String,
    expected: Schema.Literal("file", "directory"),
    actual: Schema.String,
    remediation: Schema.String,
  },
) {}
