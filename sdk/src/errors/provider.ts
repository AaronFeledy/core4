import { Schema } from "effect";

const ProviderErrorBase = {
  providerId: Schema.String,
  operation: Schema.String,
  message: Schema.String,
  details: Schema.optional(Schema.Unknown),
  remediation: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Unknown),
};

export class ProviderUnavailableError extends Schema.TaggedError<ProviderUnavailableError>()(
  "ProviderUnavailableError",
  ProviderErrorBase,
) {}

export class ProviderCapabilityError extends Schema.TaggedError<ProviderCapabilityError>()(
  "ProviderCapabilityError",
  {
    ...ProviderErrorBase,
    capability: Schema.String,
    requiredValue: Schema.Unknown,
    actualValue: Schema.Unknown,
  },
) {}

export class ProviderConfigError extends Schema.TaggedError<ProviderConfigError>()(
  "ProviderConfigError",
  ProviderErrorBase,
) {}

export class ProviderInternalError extends Schema.TaggedError<ProviderInternalError>()(
  "ProviderInternalError",
  ProviderErrorBase,
) {}

export class ArtifactBuildError extends Schema.TaggedError<ArtifactBuildError>()(
  "ArtifactBuildError",
  ProviderErrorBase,
) {}

export class ServiceStartError extends Schema.TaggedError<ServiceStartError>()("ServiceStartError", {
  ...ProviderErrorBase,
  service: Schema.String,
}) {}

export class ServiceExecError extends Schema.TaggedError<ServiceExecError>()("ServiceExecError", {
  ...ProviderErrorBase,
  service: Schema.String,
}) {}

export class ServiceNotFoundError extends Schema.TaggedError<ServiceNotFoundError>()("ServiceNotFoundError", {
  ...ProviderErrorBase,
  service: Schema.String,
}) {}

export class NoProviderInstalledError extends Schema.TaggedError<NoProviderInstalledError>()(
  "NoProviderInstalledError",
  {
    message: Schema.String,
    suggestion: Schema.optional(Schema.String),
  },
) {}

export class CapabilityError extends Schema.TaggedError<CapabilityError>()("CapabilityError", {
  message: Schema.String,
  service: Schema.optional(Schema.String),
  feature: Schema.optional(Schema.String),
  capability: Schema.String,
  providerId: Schema.String,
  remediation: Schema.optional(Schema.String),
}) {}
