import { Schema } from "effect";

export class ServiceTypeError extends Schema.TaggedError<ServiceTypeError>()("ServiceTypeError", {
  message: Schema.String,
  serviceType: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

export class ServiceFeatureError extends Schema.TaggedError<ServiceFeatureError>()("ServiceFeatureError", {
  message: Schema.String,
  feature: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

/**
 * A service type's `extends:` inheritance is invalid: it points at an
 * unregistered parent, forms a cycle, or exceeds the maximum inheritance depth
 * of 4. Raised at plugin/service-type load time before any `resolve()` runs.
 * `chain` is the parent-to-child id path that triggered the rejection.
 */
export class ServiceTypeCollisionError extends Schema.TaggedError<ServiceTypeCollisionError>()(
  "ServiceTypeCollisionError",
  {
    message: Schema.String,
    serviceType: Schema.String,
    chain: Schema.Array(Schema.String),
    remediation: Schema.optional(Schema.String),
  },
) {}

/**
 * An app-feature's selectors resolved to zero services. Raised by the
 * app-feature pass when a feature activated but its `selectors`
 * matched no service draft, so its `apply` would be a silent no-op.
 */
export class AppFeatureSelectorMatchedNothingError extends Schema.TaggedError<AppFeatureSelectorMatchedNothingError>()(
  "SelectorMatchedNothing",
  {
    message: Schema.String,
    feature: Schema.String,
    remediation: Schema.optional(Schema.String),
  },
) {}

/**
 * Two activated app-features wrote conflicting values to the same keyed field
 * on the same service draft (e.g. different `addEnv` values for one key).
 * Idempotent replay of the same value is allowed; divergent writes are not.
 */
export class AppFeatureMutationConflictError extends Schema.TaggedError<AppFeatureMutationConflictError>()(
  "MutationConflict",
  {
    message: Schema.String,
    feature: Schema.String,
    service: Schema.String,
    field: Schema.String,
    existing: Schema.optional(Schema.Unknown),
    incoming: Schema.optional(Schema.Unknown),
    remediation: Schema.optional(Schema.String),
  },
) {}

/**
 * The activated app-features form a directed mutation cycle (feature A mutates
 * a service that triggers feature B, which mutates a service that triggers
 * feature A). The `CycleDetected` member of the {@link AppFeatureError} union.
 */
export class AppFeatureCycleError extends Schema.TaggedError<AppFeatureCycleError>()("CycleDetected", {
  message: Schema.String,
  cycle: Schema.Array(Schema.String),
  remediation: Schema.optional(Schema.String),
}) {}

/**
 * The tagged union an `AppFeature.apply` may fail with:
 * `SelectorMatchedNothing` | `MutationConflict` | `CycleDetected`.
 */
export type AppFeatureError =
  | AppFeatureSelectorMatchedNothingError
  | AppFeatureMutationConflictError
  | AppFeatureCycleError;
