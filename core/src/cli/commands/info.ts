import { Effect, Schema } from "effect";

import type {
  InfoAppError,
  InfoAppOptions,
  InfoAppResult,
  InfoAppService,
  InfoServiceStatus,
} from "@lando/sdk/app";
import type { AppPlan, LandofileShape, PublishedEndpoint, ServiceName, ServicePlan } from "@lando/sdk/schema";
import {
  AppPlanner,
  type ConfigService,
  LandofileService,
  ProxyService,
  RuntimeProviderRegistry,
} from "@lando/sdk/services";

import { resolveAgentEnvAudit } from "../../config/agent-env-policy.ts";
import { routeUrlsForPlan } from "../../lifecycle/routes.ts";
import { hostProxyPlanExtension } from "../../subsystems/host-proxy/plan-extension.ts";
import { type ResolvedAppTarget, loadUserLandofile, loadUserLandofileAt } from "../app-resolution.ts";
import { type MaterializedPublishedEndpoint, publishedEndpointUrl } from "../authority-url.ts";

export type { InfoAppError, InfoAppOptions, InfoAppResult, InfoAppService } from "@lando/sdk/app";
export { buildInfoSummary, renderInfoAppResult } from "./info-render.ts";

type InfoAppServices = AppPlanner | ConfigService | LandofileService | RuntimeProviderRegistry;

const InfoServiceStatusSchema = Schema.Literal(
  "unknown",
  "stopped",
  "starting",
  "running",
  "healthy",
  "unhealthy",
  "error",
);

const AppInfoLogSourceSchema = Schema.Struct({
  id: Schema.String,
  path: Schema.String,
  strategy: Schema.Literal("redirect", "follow"),
  availability: Schema.Literal("available", "redirected-to-console", "unavailable"),
  reason: Schema.optional(Schema.String),
});

export const AppInfoServiceSchema = Schema.Struct({
  app: Schema.String,
  service: Schema.String,
  api: Schema.Literal(4),
  type: Schema.String,
  provider: Schema.String,
  primary: Schema.Boolean,
  status: InfoServiceStatusSchema,
  endpoints: Schema.Array(Schema.String),
  logSources: Schema.optional(Schema.Array(AppInfoLogSourceSchema)),
});

export const AppInfoAgentEnvSchema = Schema.Struct({
  enabled: Schema.Boolean,
  forwarded: Schema.Array(Schema.String),
});

const AppInfoHostProxySchema = Schema.Struct({
  runLando: Schema.Struct({
    availability: Schema.Literal("available", "unavailable"),
    reason: Schema.optional(Schema.String),
  }),
});

export const AppInfoResultSchema = Schema.Struct({
  app: Schema.String,
  services: Schema.Array(AppInfoServiceSchema),
  agentEnv: Schema.optional(AppInfoAgentEnvSchema),
  hostProxy: Schema.optional(AppInfoHostProxySchema),
});

const statusText = (status: string | undefined): InfoServiceStatus => {
  switch (status) {
    case "stopped":
    case "starting":
    case "running":
    case "healthy":
    case "unhealthy":
    case "error":
      return status;
    default:
      return "unknown";
  }
};

const endpointText = (
  service: ServicePlan,
  endpoint: PublishedEndpoint & MaterializedPublishedEndpoint,
): ReadonlyArray<string> => {
  if (service.type === "postgres") {
    const user = service.environment.POSTGRES_USER ?? "lando";
    const database = service.environment.POSTGRES_DB ?? "postgres";
    const url = publishedEndpointUrl(endpoint, "postgresql");
    return url === undefined ? [] : [`${url.replace("postgresql://", `postgresql://${user}@`)}/${database}`];
  }
  if (service.type === "memcached" && endpoint.protocol === "tcp") {
    const url = publishedEndpointUrl(endpoint, "memcached");
    return url === undefined ? [] : [url];
  }
  if (service.type === "valkey" && endpoint.protocol === "tcp") {
    const valkey = publishedEndpointUrl(endpoint, "valkey");
    const redis = publishedEndpointUrl(endpoint, "redis");
    return valkey === undefined || redis === undefined ? [] : [valkey, redis];
  }
  const url = publishedEndpointUrl(endpoint);
  return url === undefined ? [] : [url];
};

const toServiceInfo = (
  plan: AppPlan,
  service: ServicePlan,
  status: InfoServiceStatus,
  endpoints: ReadonlyArray<string>,
  serviceLogSources: boolean,
): InfoAppService => {
  const logSources = (service.logSources ?? []).map((source) => {
    const base = { id: String(source.id), path: String(source.path), strategy: source.strategy };
    if (source.strategy === "redirect") {
      return { ...base, availability: "redirected-to-console" as const };
    }
    if (serviceLogSources) return { ...base, availability: "available" as const };
    return {
      ...base,
      availability: "unavailable" as const,
      reason:
        "Provider does not advertise serviceLogSources; use strategy: redirect or choose a provider with serviceLogSources.",
    };
  });
  return {
    app: String(plan.id),
    service: String(service.name),
    api: 4,
    type: service.type,
    provider: String(service.provider),
    primary: service.primary,
    status,
    endpoints,
    ...(logSources.length === 0 ? {} : { logSources }),
  };
};

// Requires only RuntimeProviderRegistry (no LandofileService/AppPlanner) so
// out-of-band plan resolvers (global-app commands) reuse this without pulling
// user-Landofile resolution into their bootstrap layer.
export const infoForPlan = (
  plan: AppPlan,
): Effect.Effect<InfoAppResult, InfoAppError, RuntimeProviderRegistry> =>
  Effect.gen(function* () {
    const registry = yield* RuntimeProviderRegistry;
    const proxy = yield* Effect.serviceOption(ProxyService);
    const provider = yield* registry.select(plan);
    const routedUrls =
      proxy._tag === "Some"
        ? yield* routeUrlsForPlan(proxy.value, plan)
        : new Map<ServiceName, ReadonlyArray<string>>();

    const serviceLogSources = provider.capabilities.serviceLogSources === true;
    const services = yield* Effect.forEach(Object.values(plan.services), (service) =>
      provider.inspect({ app: plan.id, service: service.name, plan }).pipe(
        Effect.map((runtime) => {
          const status = statusText(runtime.state ?? runtime.status);
          return toServiceInfo(
            plan,
            service,
            status,
            status === "stopped"
              ? []
              : [
                  ...(routedUrls.get(service.name) ?? []),
                  ...(runtime.endpoints ?? service.endpoints).flatMap((endpoint) =>
                    endpoint._tag === "published" ? endpointText(service, endpoint) : [],
                  ),
                ],
            serviceLogSources,
          );
        }),
      ),
    );

    const hostProxy = hostProxyPlanExtension(plan);
    return { app: plan.name, services, ...(hostProxy === undefined ? {} : { hostProxy }) };
  });

export const infoApp = (
  options?: InfoAppOptions,
  target?: ResolvedAppTarget,
): Effect.Effect<InfoAppResult, InfoAppError, InfoAppServices> =>
  Effect.gen(function* () {
    const landofileService = yield* LandofileService;
    const registry = yield* RuntimeProviderRegistry;
    const planner = yield* AppPlanner;

    let plan: AppPlan;
    let landofile: LandofileShape | undefined;
    if (target?.plan !== undefined) {
      plan = target.plan;
      if (options?.deep === true) {
        landofile = yield* loadUserLandofileAt(landofileService, target.root);
      }
    } else {
      landofile = yield* loadUserLandofile(landofileService);
      const capabilities = yield* registry.capabilities;
      plan = yield* planner.plan(landofile, capabilities);
    }

    const result = yield* infoForPlan(plan);
    if (options?.deep !== true) return result;
    const agentEnv = yield* resolveAgentEnvAudit(landofile?.agentEnv, process.env);
    return { ...result, agentEnv };
  });
