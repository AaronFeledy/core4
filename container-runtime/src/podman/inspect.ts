import { DateTime, Effect, Option } from "effect";
import { serviceContainerName } from "../plan.ts";

import { ProviderUnavailableError } from "@lando/sdk/errors";
import type { AppPlan, EndpointPlan, PublishedEndpoint, ServicePlan } from "@lando/sdk/schema";
import type { ProviderError, ServiceRuntimeInfo, ServiceSelector } from "@lando/sdk/services";

import type {
  EngineHttpApi,
  EngineHttpRequest,
  EngineHttpResponse,
  ProviderErrorContext,
} from "../engine-api.ts";
import { missingApi, missingService, parseEngineJson } from "../engine-errors.ts";
import { withApiReason } from "../redact.ts";

interface ContainerInspect {
  readonly Id?: string;
  readonly Image?: string;
  readonly State?: {
    readonly Health?: { readonly Status?: string };
    readonly Running?: boolean;
    readonly Status?: string;
    readonly StartedAt?: string;
    readonly ExitCode?: number;
  };
  readonly NetworkSettings?: {
    readonly Ports?: Record<string, Array<{ readonly HostIp?: string; readonly HostPort?: string }> | null>;
  };
}

export const publishedEndpointsFromInspect = (
  inspect: unknown,
  plannedEndpoints: ReadonlyArray<EndpointPlan> = [],
): NonNullable<ServiceRuntimeInfo["endpoints"]> => {
  if (typeof inspect !== "object" || inspect === null) return [];
  const ports = (inspect as ContainerInspect).NetworkSettings?.Ports;
  if (typeof ports !== "object" || ports === null) return [];

  const endpoints: Array<NonNullable<ServiceRuntimeInfo["endpoints"]>[number]> = [];
  for (const [containerPort, bindings] of Object.entries(ports)) {
    if (!Array.isArray(bindings)) continue;
    const [portNum, protocol] = containerPort.split("/");
    const port = Number.parseInt(portNum ?? "0", 10);
    if (port <= 0) continue;
    const transport = protocol === "udp" ? "udp" : "tcp";
    const planned = plannedEndpoints.find(
      (endpoint): endpoint is PublishedEndpoint =>
        endpoint._tag === "published" &&
        endpoint.port === port &&
        (endpoint.protocol === "udp" ? "udp" : "tcp") === transport,
    );
    for (const binding of bindings) {
      if (typeof binding !== "object" || binding === null) continue;
      const hostPort = Number.parseInt(typeof binding.HostPort === "string" ? binding.HostPort : "0", 10);
      if (hostPort <= 0) continue;
      const materialization = {
        bindAddress: typeof binding.HostIp === "string" ? binding.HostIp : "0.0.0.0",
        hostPort,
      };
      if (planned !== undefined) {
        endpoints.push({ ...planned, materialization });
        continue;
      }
      endpoints.push({
        _tag: "published" as const,
        port,
        protocol: transport,
        name: containerPort,
        publication: materialization,
      });
    }
  }
  return endpoints;
};

export interface InspectOptions {
  readonly api?: EngineHttpApi;
  readonly ctx: ProviderErrorContext;
}

const containerName = (plan: AppPlan, service: ServicePlan) => serviceContainerName(plan, service.name);

const request = (
  deps: { readonly api: EngineHttpApi; readonly ctx: ProviderErrorContext },
  input: EngineHttpRequest,
  operation: string,
): Effect.Effect<EngineHttpResponse, ProviderError> =>
  deps.api.request === undefined ? Effect.fail(missingApi(deps.ctx, operation)) : deps.api.request(input);

const statusFromInspect = (inspect: ContainerInspect): string => {
  if (inspect.State?.Running === true || inspect.State?.Status === "running") {
    return "running";
  }
  return "stopped";
};

const healthFromInspect = (inspect: ContainerInspect): ServiceRuntimeInfo["health"] | undefined => {
  const status = inspect.State?.Health?.Status?.trim().toLowerCase();
  switch (status) {
    case "healthy":
    case "starting":
    case "unhealthy":
      return status;
    default:
      return undefined;
  }
};

const lastStartedAt = (inspect: ContainerInspect): Date | undefined => {
  const startedAt = inspect.State?.StartedAt;
  if (startedAt === undefined || startedAt.length === 0 || startedAt.startsWith("0001-")) {
    return undefined;
  }
  const parsed = DateTime.make(startedAt);
  return Option.isNone(parsed) ? undefined : DateTime.toDate(parsed.value);
};

export const inspect = Effect.fn("RuntimeProvider.inspect")(function* (
  plan: AppPlan,
  target: ServiceSelector,
  options: InspectOptions,
): Effect.fn.Return<ServiceRuntimeInfo, ProviderError> {
  const ctx = options.ctx;
  const service = plan.services[target.service];
  if (service === undefined) {
    return yield* Effect.fail(missingService(ctx, target, "inspect"));
  }
  if (options.api === undefined) {
    return yield* Effect.fail(missingApi(ctx, "inspect"));
  }

  const deps = { api: options.api, ctx };

  const response = yield* request(
    deps,
    {
      method: "GET",
      path: `/containers/${encodeURIComponent(containerName(plan, service))}/json`,
    },
    "inspect",
  );

  if (response.status === 404) {
    return {
      app: plan.id,
      appRoot: plan.root,
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
        providerId: ctx.providerId,
        operation: "inspect",
        message: withApiReason(`provider-${ctx.providerId} inspect failed with HTTP ${response.status}.`, {
          body: response.body,
        }),
        details: { service: service.name, body: response.body },
        remediation: ctx.remediation,
      }),
    );
  }

  const decoded = (yield* parseEngineJson(response, ctx, "inspect")) as ContainerInspect;
  const status = statusFromInspect(decoded);
  const health = healthFromInspect(decoded);
  const startedAt = lastStartedAt(decoded);
  const materialized = publishedEndpointsFromInspect(decoded, service.endpoints);
  return {
    app: plan.id,
    appRoot: plan.root,
    service: service.name,
    providerId: plan.provider,
    status,
    state: status,
    ...(health === undefined ? {} : { health }),
    ...(typeof decoded.Id === "string" && decoded.Id.length > 0 ? { containerId: decoded.Id } : {}),
    ...(typeof decoded.Image === "string" && decoded.Image.length > 0
      ? { imageIdentity: decoded.Image }
      : {}),
    endpoints: materialized.length > 0 ? materialized : service.endpoints,
    ...(startedAt === undefined ? {} : { lastStartedAt: startedAt }),
  };
});
