import { Effect } from "effect";

import { ProviderInternalError, ProviderUnavailableError, ServiceNotFoundError } from "@lando/sdk/errors";
import type { AppPlan, ServicePlan } from "@lando/sdk/schema";
import type { ProviderError, ServiceRuntimeInfo, ServiceSelector } from "@lando/sdk/services";

import type {
  EngineHttpApi,
  EngineHttpRequest,
  EngineHttpResponse,
  ProviderErrorContext,
} from "../engine-api.ts";
import { missingApi } from "../engine-errors.ts";
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
    for (const binding of bindings) {
      if (typeof binding !== "object" || binding === null) continue;
      const hostPort = Number.parseInt(typeof binding.HostPort === "string" ? binding.HostPort : "0", 10);
      if (hostPort <= 0) continue;
      endpoints.push({
        _tag: "published" as const,
        port,
        protocol: protocol === "udp" ? ("udp" as const) : ("http" as const),
        name: containerPort,
        publication: {
          bindAddress: typeof binding.HostIp === "string" ? binding.HostIp : "0.0.0.0",
          hostPort,
        },
      });
    }
  }
  return endpoints;
};

export interface InspectOptions {
  readonly api?: EngineHttpApi;
  readonly ctx: ProviderErrorContext;
}

const containerName = (plan: AppPlan, service: ServicePlan) =>
  `lando-${plan.slug}-${service.name}`.replace(/[^a-zA-Z0-9_.-]/gu, "-");

const apiRequired = (ctx: ProviderErrorContext, operation: string): ProviderUnavailableError =>
  missingApi(ctx, operation, `provider-${ctx.providerId} ${operation} requires an engine API client.`);

const missingService = (ctx: ProviderErrorContext, target: ServiceSelector, operation: string) =>
  new ServiceNotFoundError({
    providerId: ctx.providerId,
    operation,
    service: target.service,
    message: `Service ${target.service} is not present in the app plan.`,
  });

const request = (
  deps: { readonly api: EngineHttpApi; readonly ctx: ProviderErrorContext },
  input: EngineHttpRequest,
  operation: string,
): Effect.Effect<EngineHttpResponse, ProviderError> =>
  deps.api.request === undefined ? Effect.fail(apiRequired(deps.ctx, operation)) : deps.api.request(input);

const parseJson = (
  ctx: ProviderErrorContext,
  response: EngineHttpResponse,
): Effect.Effect<unknown, ProviderInternalError> =>
  Effect.try({
    try: () => (response.body.length === 0 ? {} : JSON.parse(response.body)),
    catch: (cause) =>
      new ProviderInternalError({
        providerId: ctx.providerId,
        operation: "inspect",
        message: `provider-${ctx.providerId} API returned invalid JSON.`,
        cause,
      }),
  });

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
  const parsed = new Date(startedAt);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
};

export const inspect = (
  plan: AppPlan,
  target: ServiceSelector,
  options: InspectOptions,
): Effect.Effect<ServiceRuntimeInfo, ProviderError> => {
  const ctx = options.ctx;
  const service = plan.services[target.service];
  if (service === undefined) {
    return Effect.fail(missingService(ctx, target, "inspect"));
  }
  if (options.api === undefined) {
    return Effect.fail(apiRequired(ctx, "inspect"));
  }

  const deps = { api: options.api, ctx };
  return Effect.gen(function* () {
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

    const decoded = (yield* parseJson(ctx, response)) as ContainerInspect;
    const status = statusFromInspect(decoded);
    const health = healthFromInspect(decoded);
    const startedAt = lastStartedAt(decoded);
    const materialized = publishedEndpointsFromInspect(decoded);
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
};
