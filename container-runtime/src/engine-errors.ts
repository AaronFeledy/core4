import { ProviderInternalError, ProviderUnavailableError } from "@lando/sdk/errors";

import type { EngineHttpRequest, ProviderErrorContext } from "./engine-api.ts";
import { redactDetails, withApiReason } from "./redact.ts";
import { ContainerTransportError } from "./transport.ts";

export const missingApi = (
  ctx: ProviderErrorContext,
  operation: string,
  message: string,
): ProviderUnavailableError =>
  new ProviderUnavailableError({
    providerId: ctx.providerId,
    operation,
    message,
    remediation: ctx.remediation,
  });

export const transportFailure = (
  ctx: ProviderErrorContext,
  operation: string,
  cause: ContainerTransportError,
): ProviderUnavailableError | ProviderInternalError => {
  const input = {
    providerId: ctx.providerId,
    operation,
    message: withApiReason(cause.message, cause.details),
    ...(cause.details === undefined ? {} : { details: redactDetails(cause.details) }),
    remediation: ctx.remediation,
    cause,
  };
  return cause.kind === "parse" ? new ProviderInternalError(input) : new ProviderUnavailableError(input);
};

export const engineApiFailure = (
  ctx: ProviderErrorContext,
  operation: string,
  request: EngineHttpRequest,
  cause: unknown,
): ProviderUnavailableError | ProviderInternalError => {
  if (cause instanceof ProviderUnavailableError || cause instanceof ProviderInternalError) return cause;
  if (cause instanceof ContainerTransportError) return transportFailure(ctx, operation, cause);
  return new ProviderUnavailableError({
    providerId: ctx.providerId,
    operation,
    message: "Failed to call the container engine API.",
    details: redactDetails({ method: request.method, path: request.path }),
    remediation: ctx.remediation,
    cause,
  });
};
