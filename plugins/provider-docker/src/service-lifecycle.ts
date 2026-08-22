import { Effect } from "effect";

import { ProviderUnavailableError, ServiceNotFoundError } from "@lando/sdk/errors";
import type { AppPlan, ServicePlan } from "@lando/sdk/schema";
import type { ProviderError, ServiceSelector } from "@lando/sdk/services";

import type { DockerApiClient } from "./index.ts";

export type ServiceLifecycleAction = "start" | "stop" | "restart";

export type ServiceLifecycleInput = {
  readonly api: DockerApiClient;
  readonly plan: AppPlan;
  readonly target: ServiceSelector;
  readonly action: ServiceLifecycleAction;
};

const PROVIDER_ID = "docker";

const containerName = (plan: AppPlan, service: ServicePlan) =>
  `lando-${plan.slug}-${service.name}`.replace(/[^a-zA-Z0-9_.-]/gu, "-");

export const postServiceLifecycle = (input: ServiceLifecycleInput): Effect.Effect<void, ProviderError> => {
  const service = input.plan.services[input.target.service];
  if (service === undefined) {
    return Effect.fail(
      new ServiceNotFoundError({
        providerId: PROVIDER_ID,
        operation: input.action,
        service: input.target.service,
        message: `Service ${input.target.service} is not present in the app plan.`,
      }),
    );
  }
  const request = input.api.request;
  if (request === undefined) {
    return Effect.fail(
      new ProviderUnavailableError({
        providerId: PROVIDER_ID,
        operation: input.action,
        message: `provider-docker ${input.action} requires a Docker API client.`,
      }),
    );
  }

  const name = containerName(input.plan, service);
  return request({
    method: "POST",
    path: `/containers/${encodeURIComponent(name)}/${input.action}`,
  }).pipe(
    Effect.mapError(
      (cause): ProviderError =>
        new ProviderUnavailableError({
          providerId: PROVIDER_ID,
          operation: input.action,
          message: `provider-docker ${input.action} request failed.`,
          cause,
        }),
    ),
    Effect.flatMap((response): Effect.Effect<void, ProviderError> => {
      if (response.status === 204 || response.status === 304) {
        return Effect.void;
      }
      if (response.status === 404) {
        return Effect.fail(
          new ServiceNotFoundError({
            providerId: PROVIDER_ID,
            operation: input.action,
            service: input.target.service,
            message: `Service ${input.target.service} was not found.`,
          }),
        );
      }
      return Effect.fail(
        new ProviderUnavailableError({
          providerId: PROVIDER_ID,
          operation: input.action,
          message: `Container ${input.action} failed with HTTP ${response.status}.`,
          details: { service: service.name, body: response.body },
        }),
      );
    }),
  );
};
