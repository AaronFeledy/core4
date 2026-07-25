import { Schema } from "effect";

import { ProviderId } from "../schema/primitives.ts";

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

export class PublicationUnsupportedError extends Schema.TaggedError<PublicationUnsupportedError>()(
  "PublicationUnsupportedError",
  {
    message: Schema.String,
    service: Schema.String,
    providerId: Schema.String,
    capability: Schema.Literal("hostPortPublish"),
    remediation: Schema.String,
  },
) {}

const ProviderSetupErrorBase = {
  providerId: ProviderId,
  message: Schema.String,
  remediation: Schema.String,
};

export class ProviderSetupConsentDeniedError extends Schema.TaggedError<ProviderSetupConsentDeniedError>()(
  "ProviderSetupConsentDeniedError",
  { ...ProviderSetupErrorBase, change: Schema.Literal("install-uidmap") },
) {}

export class ProviderSetupUnsupportedHostError extends Schema.TaggedError<ProviderSetupUnsupportedHostError>()(
  "ProviderSetupUnsupportedHostError",
  {
    ...ProviderSetupErrorBase,
    prerequisite: Schema.String,
    host: Schema.optional(Schema.Struct({ id: Schema.String, versionId: Schema.String })),
  },
) {}

export class ProviderSetupPrivilegeUnavailableError extends Schema.TaggedError<ProviderSetupPrivilegeUnavailableError>()(
  "ProviderSetupPrivilegeUnavailableError",
  { ...ProviderSetupErrorBase, change: Schema.Literal("install-uidmap") },
) {}

export class ProviderSetupProvisioningError extends Schema.TaggedError<ProviderSetupProvisioningError>()(
  "ProviderSetupProvisioningError",
  {
    ...ProviderSetupErrorBase,
    change: Schema.Literal("install-uidmap"),
    stage: Schema.Literal("update", "install", "verify"),
    exitCode: Schema.optional(Schema.Number),
    stderr: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export class VolumeOperationError extends Schema.TaggedError<VolumeOperationError>()("VolumeOperationError", {
  ...ProviderErrorBase,
  store: Schema.optional(Schema.String),
}) {}

export class ServiceCopyError extends Schema.TaggedError<ServiceCopyError>()("ServiceCopyError", {
  ...ProviderErrorBase,
  service: Schema.optional(Schema.String),
}) {}

export class ArtifactTransferError extends Schema.TaggedError<ArtifactTransferError>()(
  "ArtifactTransferError",
  {
    ...ProviderErrorBase,
    artifactRef: Schema.optional(Schema.String),
  },
) {}
