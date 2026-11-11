import {
  ArtifactBuildError,
  ArtifactTransferError,
  EnvironmentValueResolutionError,
  HealthcheckTargetUnsupportedError,
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
import { Schema } from "effect";

import { redactProviderDetails } from "./provider-details.ts";

export const isProviderError = Schema.is(
  Schema.Union([
    SecretNotFoundError,
    SecretReferenceInvalidError,
    SecretStoreUnavailableError,
    EnvironmentValueResolutionError,
    PlanReplanRequiredError,
    ProviderUnavailableError,
    ProviderCapabilityError,
    ProviderConfigError,
    ProviderInternalError,
    ArtifactBuildError,
    HealthcheckTargetUnsupportedError,
    ServiceExecError,
    ServiceNotFoundError,
    ServiceRestartWouldRecreateError,
    ServiceStartError,
    VolumeOperationError,
    ServiceCopyError,
    ArtifactTransferError,
    ProviderSetupConsentDeniedError,
    ProviderSetupPrivilegeUnavailableError,
    ProviderSetupProvisioningError,
    ProviderSetupUnsupportedHostError,
  ]),
);

interface ReconstructionOptions {
  readonly cause?: "keep" | "omit";
}

const baseFields = (
  error: Pick<
    ProviderUnavailableError,
    "providerId" | "operation" | "message" | "details" | "remediation" | "cause"
  >,
  redactor: Redactor,
  options: ReconstructionOptions,
) => ({
  providerId: redactor.redactString(error.providerId),
  operation: redactor.redactString(error.operation),
  message: redactor.redactString(error.message),
  ...(error.details === undefined ? {} : { details: redactProviderDetails(error.details, redactor) }),
  remediation: redactor.redactString(error.remediation),
  ...(options.cause === "omit" || error.cause === undefined ? {} : { cause: error.cause }),
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
export function redactProviderError<E extends ProviderError>(
  error: E,
  redactor: Redactor,
  options?: ReconstructionOptions,
): E;
export function redactProviderError(
  error: ProviderError,
  redactor: Redactor,
  options: ReconstructionOptions = {},
): ProviderError {
  // Reconstruct, never clone: TaggedError serialization retains its constructor arguments.
  switch (error._tag) {
    case "SecretNotFoundError":
      return new SecretNotFoundError({
        message: redactor.redactString(error.message),
        secret: redactor.redactString(error.secret),
        remediation: redactor.redactString(error.remediation),
      });
    case "SecretReferenceInvalidError":
      return new SecretReferenceInvalidError({
        message: redactor.redactString(error.message),
        reference: redactor.redactString(error.reference),
        remediation: redactor.redactString(error.remediation),
      });
    case "SecretStoreUnavailableError":
      return new SecretStoreUnavailableError({
        reason: error.reason,
        message: redactor.redactString(error.message),
        storeId: redactor.redactString(error.storeId),
        remediation: redactor.redactString(error.remediation),
      });
    case "EnvironmentValueResolutionError":
      return new EnvironmentValueResolutionError({
        reason: error.reason,
        message: redactor.redactString(error.message),
        ...(error.variable === undefined ? {} : { variable: redactor.redactString(error.variable) }),
        ...(error.reference === undefined ? {} : { reference: redactor.redactString(error.reference) }),
        remediation: redactor.redactString(error.remediation),
      });
    case "PlanReplanRequiredError":
      return new PlanReplanRequiredError({
        providerId: redactor.redactString(error.providerId),
        operation: redactor.redactString(error.operation),
        ...(error.valueModel === undefined ? {} : { valueModel: error.valueModel }),
        ...(options.cause === "omit" || error.cause === undefined ? {} : { cause: error.cause }),
        message: redactor.redactString(error.message),
        app: redactor.redactString(error.app),
        remediation: redactor.redactString(error.remediation),
      });
    case "ProviderUnavailableError":
      return new ProviderUnavailableError(baseFields(error, redactor, options));
    case "ProviderCapabilityError":
      return new ProviderCapabilityError({
        ...baseFields(error, redactor, options),
        capability: redactor.redactString(error.capability),
        requiredValue: redactProviderDetails(error.requiredValue, redactor),
        ...(error.actualValue === undefined
          ? {}
          : { actualValue: redactProviderDetails(error.actualValue, redactor) }),
      });
    case "ProviderConfigError":
      return new ProviderConfigError(baseFields(error, redactor, options));
    case "ProviderInternalError":
      return new ProviderInternalError(baseFields(error, redactor, options));
    case "ArtifactBuildError":
      return new ArtifactBuildError(baseFields(error, redactor, options));
    case "HealthcheckTargetUnsupportedError":
      return new HealthcheckTargetUnsupportedError({
        message: redactor.redactString(error.message),
        service: redactor.redactString(error.service),
        target: error.target,
        ...(error.role === undefined ? {} : { role: error.role }),
        remediation: redactor.redactString(error.remediation),
      });
    case "ServiceExecError":
      return new ServiceExecError({
        ...baseFields(error, redactor, options),
        service: redactor.redactString(error.service),
      });
    case "ServiceNotFoundError":
      return new ServiceNotFoundError({
        ...baseFields(error, redactor, options),
        service: redactor.redactString(error.service),
      });
    case "ServiceRestartWouldRecreateError":
      return new ServiceRestartWouldRecreateError({
        ...baseFields(error, redactor, options),
        service: redactor.redactString(error.service),
        reason: error.reason,
      });
    case "ServiceStartError":
      return new ServiceStartError({
        ...baseFields(error, redactor, options),
        service: redactor.redactString(error.service),
        ...(error.logTail === undefined
          ? {}
          : {
              logTail: {
                service: redactor.redactString(error.logTail.service),
                lines: error.logTail.lines.map(redactor.redactString),
                truncated: error.logTail.truncated,
                ...(error.logTail.exitCode === undefined ? {} : { exitCode: error.logTail.exitCode }),
                ...(error.logTail.timedOut === undefined ? {} : { timedOut: error.logTail.timedOut }),
              },
            }),
        ...(error.listener === undefined
          ? {}
          : {
              listener: {
                service: redactor.redactString(error.listener.service),
                port: error.listener.port,
                transport: error.listener.transport,
                basis: error.listener.basis,
                state: error.listener.state,
                listening: error.listener.listening.map((binding) => ({
                  address: redactor.redactString(binding.address),
                  port: binding.port,
                })),
              },
            }),
      });
    case "VolumeOperationError":
      return new VolumeOperationError({
        ...baseFields(error, redactor, options),
        ...(error.store === undefined ? {} : { store: redactor.redactString(error.store) }),
      });
    case "ServiceCopyError":
      return new ServiceCopyError({
        ...baseFields(error, redactor, options),
        ...(error.service === undefined ? {} : { service: redactor.redactString(error.service) }),
      });
    case "ArtifactTransferError":
      return new ArtifactTransferError({
        ...baseFields(error, redactor, options),
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
        ...(options.cause === "omit" || error.cause === undefined ? {} : { cause: error.cause }),
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
