import {
  ArtifactBuildError,
  ArtifactTransferError,
  EnvironmentValueResolutionError,
  PlanReplanRequiredError,
  ProviderCapabilityError,
  ProviderConfigError,
  ProviderInternalError,
  ProviderSetupConsentDeniedError,
  ProviderSetupPrivilegeUnavailableError,
  ProviderSetupProvisioningError,
  ProviderSetupUnsupportedHostError,
  ProviderUnavailableError,
  SecretNotFoundError,
  SecretReferenceInvalidError,
  SecretStoreUnavailableError,
  ServiceCopyError,
  ServiceExecError,
  ServiceNotFoundError,
  ServiceRestartWouldRecreateError,
  ServiceStartError,
  VolumeOperationError,
} from "@lando/sdk/errors";
import { ProviderId } from "@lando/sdk/schema";
import type { Redactor } from "@lando/sdk/secrets";
import type { ProviderError } from "@lando/sdk/services";

import { redactProviderDetails } from "./provider-details.ts";

const baseFields = (
  error: Pick<
    ProviderUnavailableError,
    "providerId" | "operation" | "message" | "details" | "remediation" | "cause"
  >,
  redactor: Redactor,
) => ({
  providerId: redactor.redactString(error.providerId),
  operation: redactor.redactString(error.operation),
  message: redactor.redactString(error.message),
  ...(error.details === undefined ? {} : { details: redactProviderDetails(error.details, redactor) }),
  remediation: redactor.redactString(error.remediation),
  ...(error.cause === undefined ? {} : { cause: error.cause }),
});

const setupFields = (
  error: Pick<ProviderSetupConsentDeniedError, "providerId" | "message" | "remediation">,
  redactor: Redactor,
) => ({
  providerId: ProviderId.make(redactor.redactString(error.providerId)),
  message: redactor.redactString(error.message),
  remediation: redactor.redactString(error.remediation),
});

// Preserve narrow error channels when redacting individual canonical classes.
export function redactProviderError(
  error: ProviderUnavailableError,
  redactor: Redactor,
): ProviderUnavailableError;
export function redactProviderError(error: ProviderConfigError, redactor: Redactor): ProviderConfigError;
export function redactProviderError(error: ProviderInternalError, redactor: Redactor): ProviderInternalError;
export function redactProviderError(error: VolumeOperationError, redactor: Redactor): VolumeOperationError;
export function redactProviderError(error: ProviderError, redactor: Redactor): ProviderError;
export function redactProviderError(error: ProviderError, redactor: Redactor): ProviderError {
  // Reconstruct, never clone: TaggedError serialization retains its constructor arguments.
  switch (error._tag) {
    case "SecretNotFoundError":
      return new SecretNotFoundError({
        ...error,
        message: redactor.redactString(error.message),
        secret: redactor.redactString(error.secret),
        remediation: redactor.redactString(error.remediation),
      });
    case "SecretReferenceInvalidError":
      return new SecretReferenceInvalidError({
        ...error,
        message: redactor.redactString(error.message),
        reference: redactor.redactString(error.reference),
        remediation: redactor.redactString(error.remediation),
      });
    case "SecretStoreUnavailableError":
      return new SecretStoreUnavailableError({
        ...error,
        message: redactor.redactString(error.message),
        storeId: redactor.redactString(error.storeId),
        remediation: redactor.redactString(error.remediation),
      });
    case "EnvironmentValueResolutionError":
      return new EnvironmentValueResolutionError({
        ...error,
        message: redactor.redactString(error.message),
        ...(error.variable === undefined ? {} : { variable: redactor.redactString(error.variable) }),
        ...(error.reference === undefined ? {} : { reference: redactor.redactString(error.reference) }),
        remediation: redactor.redactString(error.remediation),
      });
    case "PlanReplanRequiredError":
      return new PlanReplanRequiredError({
        ...error,
        message: redactor.redactString(error.message),
        app: redactor.redactString(error.app),
        remediation: redactor.redactString(error.remediation),
      });
    case "ProviderUnavailableError":
      return new ProviderUnavailableError(baseFields(error, redactor));
    case "ProviderCapabilityError":
      return new ProviderCapabilityError({
        ...baseFields(error, redactor),
        capability: redactor.redactString(error.capability),
        requiredValue: redactProviderDetails(error.requiredValue, redactor),
        actualValue: redactProviderDetails(error.actualValue, redactor),
      });
    case "ProviderConfigError":
      return new ProviderConfigError(baseFields(error, redactor));
    case "ProviderInternalError":
      return new ProviderInternalError(baseFields(error, redactor));
    case "ArtifactBuildError":
      return new ArtifactBuildError(baseFields(error, redactor));
    case "ServiceExecError":
      return new ServiceExecError({
        ...baseFields(error, redactor),
        service: redactor.redactString(error.service),
      });
    case "ServiceNotFoundError":
      return new ServiceNotFoundError({
        ...baseFields(error, redactor),
        service: redactor.redactString(error.service),
      });
    case "ServiceRestartWouldRecreateError":
      return new ServiceRestartWouldRecreateError({
        ...baseFields(error, redactor),
        service: redactor.redactString(error.service),
        reason: error.reason,
      });
    case "ServiceStartError":
      return new ServiceStartError({
        ...baseFields(error, redactor),
        service: redactor.redactString(error.service),
        ...(error.logTail === undefined
          ? {}
          : {
              logTail: {
                ...error.logTail,
                service: redactor.redactString(error.logTail.service),
                lines: error.logTail.lines.map(redactor.redactString),
              },
            }),
      });
    case "VolumeOperationError":
      return new VolumeOperationError({
        ...baseFields(error, redactor),
        ...(error.store === undefined ? {} : { store: redactor.redactString(error.store) }),
      });
    case "ServiceCopyError":
      return new ServiceCopyError({
        ...baseFields(error, redactor),
        ...(error.service === undefined ? {} : { service: redactor.redactString(error.service) }),
      });
    case "ArtifactTransferError":
      return new ArtifactTransferError({
        ...baseFields(error, redactor),
        ...(error.artifactRef === undefined ? {} : { artifactRef: redactor.redactString(error.artifactRef) }),
      });
    case "ProviderSetupConsentDeniedError":
      return new ProviderSetupConsentDeniedError({ ...setupFields(error, redactor), change: error.change });
    case "ProviderSetupPrivilegeUnavailableError":
      return new ProviderSetupPrivilegeUnavailableError({
        ...setupFields(error, redactor),
        change: error.change,
      });
    case "ProviderSetupProvisioningError":
      return new ProviderSetupProvisioningError({
        ...setupFields(error, redactor),
        change: error.change,
        stage: error.stage,
        ...(error.exitCode === undefined ? {} : { exitCode: error.exitCode }),
        ...(error.stderr === undefined ? {} : { stderr: redactor.redactString(error.stderr) }),
        ...(error.cause === undefined ? {} : { cause: error.cause }),
      });
    case "ProviderSetupUnsupportedHostError":
      return new ProviderSetupUnsupportedHostError({
        ...setupFields(error, redactor),
        prerequisite: redactor.redactString(error.prerequisite),
        ...(error.host === undefined
          ? {}
          : {
              host: {
                id: redactor.redactString(error.host.id),
                versionId: redactor.redactString(error.host.versionId),
              },
            }),
      });
    default: {
      const exhaustive: never = error;
      return exhaustive;
    }
  }
}
