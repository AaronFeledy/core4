import { Effect } from "effect";

import { ProviderInternalError, ProviderUnavailableError, ServiceNotFoundError } from "@lando/sdk/errors";
import type { AppPlan, ServicePlan } from "@lando/sdk/schema";
import type { ProviderError, ServiceRuntimeInfo, ServiceSelector } from "@lando/sdk/services";

import type { PodmanApiClient, PodmanHttpRequest, PodmanHttpResponse } from "./capabilities.ts";
import { withApiReason } from "./redact.ts";

const PROVIDER_ID = "lando";

interface ContainerInspect {
  readonly Id?: string;
  readonly State?: {
    readonly Running?: boolean;
    readonly Status?: string;
    readonly StartedAt?: string;
  };
}

export interface InspectOptions {
  readonly podmanApi?: PodmanApiClient;
}

const containerName = (plan: AppPlan, service: ServicePlan) =>
  `lando-${plan.slug}-${service.name}`.replace(/[^a-zA-Z0-9_.-]/gu, "-");

const missingApi = () =>
  new ProviderUnavailableError({
    providerId: PROVIDER_ID,
    operation: "inspect",
    message: "provider-lando inspect requires a Podman API client.",
  });

const missingService = (target: ServiceSelector) =>
  new ServiceNotFoundError({
    providerId: PROVIDER_ID,
    operation: "inspect",
    service: target.service,
    message: `Service ${target.service} is not present in the app plan.`,
  });

const request = (
  api: PodmanApiClient,
  input: PodmanHttpRequest,
): Effect.Effect<PodmanHttpResponse, ProviderError> =>
  api.request === undefined ? Effect.fail(missingApi()) : api.request(input);

const parseJson = (response: PodmanHttpResponse): Effect.Effect<unknown, ProviderInternalError> =>
  Effect.try({
    try: () => (response.body.length === 0 ? {} : JSON.parse(response.body)),
    catch: (cause) =>
      new ProviderInternalError({
        providerId: PROVIDER_ID,
        operation: "inspect",
        message: "Podman API returned invalid JSON.",
        cause,
      }),
  });

const statusFromInspect = (inspect: ContainerInspect): string => {
  if (inspect.State?.Running === true || inspect.State?.Status === "running") {
    return "running";
  }
  return "stopped";
};

const lastStartedAt = (inspect: ContainerInspect): Date | undefined => {
  const startedAt = inspect.State?.StartedAt;
  if (startedAt === undefined || startedAt.length === 0 || startedAt.startsWith("0001-")) {
    return undefined;
  }
  const parsed = new Date(startedAt);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
};

export const inspect = (
  plan: AppPlan,
  target: ServiceSelector,
  options: InspectOptions = {},
): Effect.Effect<ServiceRuntimeInfo, ProviderError> => {
  const service = plan.services[target.service];
  if (service === undefined) {
    return Effect.fail(missingService(target));
  }
  if (options.podmanApi === undefined) {
    return Effect.fail(missingApi());
  }

  const podmanApi = options.podmanApi;
  return Effect.gen(function* () {
    const response = yield* request(podmanApi, {
      method: "GET",
      path: `/containers/${encodeURIComponent(containerName(plan, service))}/json`,
    });

    if (response.status === 404) {
      return {
        app: plan.id,
        service: service.name,
        providerId: plan.provider,
        status: "stopped",
        state: "stopped",
        endpoints: service.endpoints,
      };
    }
    if (response.status < 200 || response.status >= 300) {
      yield* Effect.fail(
        new ProviderUnavailableError({
          providerId: PROVIDER_ID,
          operation: "inspect",
          message: withApiReason(`Podman inspect failed with HTTP ${response.status}.`, {
            body: response.body,
          }),
          details: { service: service.name, body: response.body },
        }),
      );
    }

    const decoded = (yield* parseJson(response)) as ContainerInspect;
    const status = statusFromInspect(decoded);
    const startedAt = lastStartedAt(decoded);
    return {
      app: plan.id,
      service: service.name,
      providerId: plan.provider,
      status,
      state: status,
      ...(typeof decoded.Id === "string" && decoded.Id.length > 0 ? { containerId: decoded.Id } : {}),
      endpoints: service.endpoints,
      ...(startedAt === undefined ? {} : { lastStartedAt: startedAt }),
    };
  });
};
