import { Schema } from "effect";

import { ValidationIssue } from "../schema/validation-issue.ts";

const Remediation = Schema.NonEmptyString.check(Schema.isPattern(/\S/u));

/**
 * A service type rejected the service's configuration while resolving it.
 * `issues` names the offending fields with paths relative to that service's
 * own config (`["environment", "PGPORT"]`, not `["services", "db", ...]`);
 * the planner places them under `services.<name>`. Without issues the
 * failure is reported against the whole service.
 */
export class ServiceTypeError extends Schema.TaggedError<ServiceTypeError>()("ServiceTypeError", {
  message: Schema.String,
  serviceType: Schema.String,
  cause: Schema.optional(Schema.Unknown),
  issues: Schema.optional(Schema.Array(ValidationIssue)).annotate({
    description:
      "Offending fields with paths relative to the service's own config; absent or empty means the whole service.",
  }),
  remediation: Remediation,
}) {}

export class ServiceFeatureError extends Schema.TaggedError<ServiceFeatureError>()("ServiceFeatureError", {
  message: Schema.String,
  feature: Schema.String,
  cause: Schema.optional(Schema.Unknown),
  remediation: Remediation,
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
    remediation: Remediation,
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
    remediation: Remediation,
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
    remediation: Remediation,
  },
) {}

/**
 * The activated app-features form a directed mutation cycle (feature A mutates
 * a service that triggers feature B, which mutates a service that triggers
 * feature A).
 */
export class AppFeatureCycleError extends Schema.TaggedError<AppFeatureCycleError>()("CycleDetected", {
  message: Schema.String,
  cycle: Schema.Array(Schema.String),
  remediation: Remediation,
}) {}

/**
 * phpMyAdmin hosts/creds resolution failed: hosts named a service that has no
 * usable credentials, or authored creds were incomplete.
 */
export class PhpMyAdminHostsCredsError extends Schema.TaggedError<PhpMyAdminHostsCredsError>()(
  "PhpMyAdminHostsCredsError",
  { message: Schema.String, feature: Schema.String, remediation: Remediation },
) {}

/**
 * Mailpit cannot pin msmtp for a selected PHP sender because the service's
 * image has no provable base image family. Raised before any provider action
 * rather than guessing a package source.
 */
export class MailpitMsmtpBaseFamilyError extends Schema.TaggedError<MailpitMsmtpBaseFamilyError>()(
  "MailpitMsmtpBaseFamilyError",
  { message: Schema.String, feature: Schema.String, remediation: Remediation },
) {}

export type AppFeatureError =
  | AppFeatureSelectorMatchedNothingError
  | AppFeatureMutationConflictError
  | AppFeatureCycleError
  | MailpitMsmtpBaseFamilyError
  | PhpMyAdminHostsCredsError;

/**
 * Raised before any provider action when a service asks for a persistent home
 * but the planner cannot know where that home is. Carries the service and the
 * two ways to resolve it.
 */
export class HomePathCapabilityError extends Schema.TaggedError<HomePathCapabilityError>()(
  "HomePathCapabilityError",
  {
    message: Schema.String,
    service: Schema.String,
    serviceType: Schema.String,
    user: Schema.optional(Schema.String),
    remediation: Remediation,
  },
) {}

/**
 * Raised before any provider action when a service mounts a data tree its
 * planned user has to write to and the planner cannot make that user own it.
 * Carries the mounted target and the Landofile option that has to change.
 */
export class DataTreeOwnershipCapabilityError extends Schema.TaggedError<DataTreeOwnershipCapabilityError>()(
  "DataTreeOwnershipCapabilityError",
  {
    message: Schema.String,
    service: Schema.String,
    serviceType: Schema.String,
    /** Container path of the data tree that cannot be owned. */
    target: Schema.String,
    /** Fully qualified Landofile key the author has to change. */
    option: Schema.String,
    user: Schema.optional(Schema.String),
    remediation: Remediation,
  },
) {}
