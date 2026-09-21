import { Effect } from "effect";

import { ProviderUnavailableError, ServiceNotFoundError } from "@lando/sdk/errors";
import type { AppPlan, ServicePlan } from "@lando/sdk/schema";
import type {
  DestroyOutcome,
  ObservedServiceRemoval,
  ProviderError,
  ServiceRuntimeIdentity,
  ServiceRuntimeInfo,
  ServiceSelector,
} from "@lando/sdk/services";

import type { EngineHttpApi, ProviderErrorContext } from "./engine-api.ts";
import { missingApi } from "./engine-errors.ts";
import { withApiReason } from "./redact.ts";

export type ServiceLifecycleAction = "start" | "stop" | "restart";

export interface ServiceLifecycleOptions {
  readonly api?: EngineHttpApi;
  readonly ctx: ProviderErrorContext;
}

export type ExactServiceLifecycleAction = "start" | "stop";

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

export const postExactServiceLifecycle = (
  target: ServiceSelector,
  identity: ServiceRuntimeIdentity,
  action: ExactServiceLifecycleAction,
  options: ServiceLifecycleOptions,
): Effect.Effect<void, ProviderError> => {
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
    path: `/containers/${encodeURIComponent(identity.containerId)}/${action}`,
  }).pipe(
    Effect.mapError(
      (cause): ProviderUnavailableError =>
        new ProviderUnavailableError({
          providerId: options.ctx.providerId,
          operation: action,
          message: `provider-${options.ctx.providerId} exact ${action} request failed.`,
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
            message: `The inspected runtime for ${target.service} was not found.`,
          }),
        );
      }
      return Effect.fail(
        new ProviderUnavailableError({
          providerId: options.ctx.providerId,
          operation: action,
          message: withApiReason(`Exact container ${action} failed with HTTP ${response.status}.`, response),
          details: { service: target.service, containerId: identity.containerId, body: response.body },
          remediation: options.ctx.remediation,
        }),
      );
    }),
  );
};

/**
 * Stops and removes the one container behind an observation the provider itself reported, without
 * consulting any applied plan. The container id is the whole address: a name could be reused by a
 * recreated container, and an observation carrying no id is a service the provider already found
 * nothing for, which is `false` rather than an error.
 */
export const removeObservedContainer = (
  observed: ServiceRuntimeInfo,
  options: ServiceLifecycleOptions,
): Effect.Effect<boolean, ProviderError> => {
  const operation = "removeObservedService";
  if (String(observed.providerId) !== options.ctx.providerId) {
    return Effect.fail(
      new ProviderUnavailableError({
        providerId: options.ctx.providerId,
        operation,
        message: `provider-${options.ctx.providerId} cannot remove a container observed by ${observed.providerId}.`,
        details: { service: observed.service, observedProvider: observed.providerId },
        remediation: options.ctx.remediation,
      }),
    );
  }
  const containerId = observed.containerId;
  if (containerId === undefined) return Effect.succeed(false);
  const request = options.api?.request;
  if (request === undefined) {
    return Effect.fail(
      missingApi(
        options.ctx,
        operation,
        `provider-${options.ctx.providerId} ${operation} requires a container engine API client.`,
      ),
    );
  }
  const call = (
    method: "POST" | "DELETE",
    path: `/${string}`,
    accepted: ReadonlyArray<number>,
    stage: string,
  ): Effect.Effect<boolean, ProviderError> =>
    request({ method, path }).pipe(
      Effect.mapError(
        (cause): ProviderUnavailableError =>
          new ProviderUnavailableError({
            providerId: options.ctx.providerId,
            operation,
            message: `provider-${options.ctx.providerId} observed container ${stage} request failed.`,
            remediation: options.ctx.remediation,
            cause,
          }),
      ),
      Effect.flatMap((response): Effect.Effect<boolean, ProviderError> => {
        if (response.status === 404) return Effect.succeed(false);
        if (accepted.includes(response.status)) return Effect.succeed(true);
        return Effect.fail(
          new ProviderUnavailableError({
            providerId: options.ctx.providerId,
            operation,
            message: withApiReason(
              `Observed container ${stage} failed with HTTP ${response.status}.`,
              response,
            ),
            details: { service: observed.service, containerId, body: response.body },
            remediation: options.ctx.remediation,
          }),
        );
      }),
    );

  // A stop that 404s means the container is already gone, so there is nothing left to remove.
  const id = encodeURIComponent(containerId);
  return call("POST", `/containers/${id}/stop`, [204, 304], "stop").pipe(
    Effect.flatMap((present) =>
      present ? call("DELETE", `/containers/${id}?force=true`, [200, 204], "remove") : Effect.succeed(false),
    ),
  );
};

/** The `destroy` answer when the provider tore resources down. */
export const DESTROYED: DestroyOutcome = { kind: "destroyed" };

/** The `destroy` answer when the provider was handed no plan and holds no applied record. */
export const DESTROY_NO_OP: DestroyOutcome = { kind: "no-op", reason: "no-applied-plan" };

/** Lifts the helper's removed/not-removed answer into the provider-contract outcome. */
export const observedRemoval = (removed: boolean): ObservedServiceRemoval =>
  removed ? { kind: "removed" } : { kind: "absent" };
