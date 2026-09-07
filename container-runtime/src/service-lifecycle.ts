import { Effect } from "effect";

import { ProviderUnavailableError, ServiceNotFoundError } from "@lando/sdk/errors";
import type { AppPlan, ServicePlan } from "@lando/sdk/schema";
import type { ProviderError, ServiceSelector } from "@lando/sdk/services";

import type { EngineHttpApi, ProviderErrorContext } from "./engine-api.ts";
import { missingApi } from "./engine-errors.ts";
import { withApiReason } from "./redact.ts";

export type ServiceLifecycleAction = "start" | "stop" | "restart";

export interface ServiceLifecycleOptions {
  readonly api?: EngineHttpApi;
  readonly ctx: ProviderErrorContext;
}

const containerName = (plan: AppPlan, service: ServicePlan): string =>
  `lando-${plan.slug}-${service.name}`.replace(/[^a-zA-Z0-9_.-]/gu, "-");

export const postServiceLifecycle = (
  plan: AppPlan,
  target: ServiceSelector,
  action: ServiceLifecycleAction,
  options: ServiceLifecycleOptions,
): Effect.Effect<void, ProviderError> => {
  const service = plan.services[target.service];
  if (service === undefined) {
    return Effect.fail(
      new ServiceNotFoundError({
        providerId: options.ctx.providerId,
        operation: action,
        service: target.service,
        message: `Service ${target.service} is not present in the app plan.`,
      }),
    );
  }
  const request = options.api?.request;
  if (request === undefined) {
    return Effect.fail(
      missingApi(
        options.ctx,
        action,
        `provider-${options.ctx.providerId} ${action} requires a container engine API client.`,
      ),
    );
  }

  return request({
    method: "POST",
    path: `/containers/${encodeURIComponent(containerName(plan, service))}/${action}`,
  }).pipe(
    Effect.mapError(
      (cause): ProviderUnavailableError =>
        new ProviderUnavailableError({
          providerId: options.ctx.providerId,
          operation: action,
          message: `provider-${options.ctx.providerId} ${action} request failed.`,
          remediation: options.ctx.remediation,
          cause,
        }),
    ),
    Effect.flatMap((response): Effect.Effect<void, ProviderError> => {
      if (response.status === 204 || response.status === 304) return Effect.void;
      if (response.status === 404) {
        return Effect.fail(
          new ServiceNotFoundError({
            providerId: options.ctx.providerId,
            operation: action,
            service: target.service,
            message: `Service ${target.service} was not found.`,
          }),
        );
      }
      return Effect.fail(
        new ProviderUnavailableError({
          providerId: options.ctx.providerId,
          operation: action,
          message: withApiReason(`Container ${action} failed with HTTP ${response.status}.`, response),
          details: { service: service.name, body: response.body },
          remediation: options.ctx.remediation,
        }),
      );
    }),
  );
};
