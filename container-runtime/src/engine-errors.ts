import { Effect } from "effect";

import { ProviderInternalError, ProviderUnavailableError } from "@lando/sdk/errors";

import type { EngineHttpRequest, EngineHttpResponse, ProviderErrorContext } from "./engine-api.ts";
import { redactDetails, withApiReason } from "./redact.ts";
import { ContainerTransportError } from "./transport.ts";

export const missingApi = (
  ctx: ProviderErrorContext,
  operation: string,
  message = `provider-${ctx.providerId} ${operation} requires an engine API client.`,
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

export const parseEngineJson = (
  response: EngineHttpResponse,
  ctx: ProviderErrorContext,
  operation: string,
  options?: { readonly message?: string; readonly details?: unknown; readonly remediation?: string },
): Effect.Effect<unknown, ProviderInternalError> =>
  Effect.try({
    try: (): unknown => (response.body.length === 0 ? {} : JSON.parse(response.body)),
    catch: (cause) =>
      new ProviderInternalError({
        providerId: ctx.providerId,
        operation,
        message: options?.message ?? `provider-${ctx.providerId} API returned invalid JSON.`,
        ...(options?.details === undefined ? {} : { details: options.details }),
        remediation: options?.remediation ?? ctx.remediation,
        cause,
      }),
  });
