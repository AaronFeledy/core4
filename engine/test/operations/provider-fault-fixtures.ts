import * as Errors from "@lando/sdk/errors";
import { ProviderId } from "@lando/sdk/schema";
import type { ProviderError } from "@lando/sdk/services";

const fields = {
  providerId: ProviderId.make("lando"),
  operation: "fault-matrix",
  message: "Injected provider seam failure.",
  remediation: "Repair the injected provider seam before retrying the operation.",
};

// A Record, rather than an array, makes adding a ProviderError tag fail typecheck
// until its in-process lifecycle coverage is supplied, including nested unions.
export const providerFaults = {
  HealthcheckTargetUnsupportedError: new Errors.HealthcheckTargetUnsupportedError({
    message: fields.message,
    remediation: fields.remediation,
    service: "web",
    target: "host",
  }),
  PlanReplanRequiredError: new Errors.PlanReplanRequiredError({ ...fields, app: "test-start" }),
  EnvironmentValueResolutionError: new Errors.EnvironmentValueResolutionError({
    ...fields,
    reason: "unresolved-binding",
  }),
  SecretNotFoundError: new Errors.SecretNotFoundError({ ...fields, secret: "database-password" }),
  SecretStoreUnavailableError: new Errors.SecretStoreUnavailableError({
    ...fields,
    storeId: "test-store",
    reason: "locked",
  }),
  SecretReferenceInvalidError: new Errors.SecretReferenceInvalidError({ ...fields, reference: "secret:" }),
  ArtifactBuildError: new Errors.ArtifactBuildError(fields),
  ProviderCapabilityError: new Errors.ProviderCapabilityError({
    ...fields,
    capability: "bindMounts",
    requiredValue: true,
    actualValue: false,
  }),
  ProviderConfigError: new Errors.ProviderConfigError(fields),
  ProviderInternalError: new Errors.ProviderInternalError(fields),
  ProviderSetupConsentDeniedError: new Errors.ProviderSetupConsentDeniedError({
    ...fields,
    change: "install-uidmap",
  }),
  ProviderSetupPrivilegeUnavailableError: new Errors.ProviderSetupPrivilegeUnavailableError({
    ...fields,
    change: "install-uidmap",
  }),
  ProviderSetupProvisioningError: new Errors.ProviderSetupProvisioningError({
    ...fields,
    change: "install-uidmap",
    stage: "install",
  }),
  ProviderSetupUnsupportedHostError: new Errors.ProviderSetupUnsupportedHostError({
    ...fields,
    prerequisite: "supported-host",
  }),
  ProviderUnavailableError: new Errors.ProviderUnavailableError(fields),
  ServiceExecError: new Errors.ServiceExecError({ ...fields, service: "web" }),
  ServiceNotFoundError: new Errors.ServiceNotFoundError({ ...fields, service: "web" }),
  ServiceRestartWouldRecreateError: new Errors.ServiceRestartWouldRecreateError({
    ...fields,
    service: "web",
    reason: "config",
  }),
  ServiceStartError: new Errors.ServiceStartError({ ...fields, service: "web" }),
  VolumeOperationError: new Errors.VolumeOperationError(fields),
  ServiceCopyError: new Errors.ServiceCopyError({ ...fields, service: "web" }),
  ArtifactTransferError: new Errors.ArtifactTransferError(fields),
} satisfies { readonly [Tag in ProviderError["_tag"]]: Extract<ProviderError, { readonly _tag: Tag }> };
