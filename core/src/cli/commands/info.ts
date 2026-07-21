import { Effect, Schema } from "effect";

import type {
  InfoAppError,
  InfoAppOptions,
  InfoAppResult,
  InfoAppService,
  InfoServiceStatus,
} from "@lando/sdk/app";
import type { AppPlan, EndpointPlan, LandofileShape, ServicePlan } from "@lando/sdk/schema";
import {
  AppPlanResolver,
  type ConfigService,
  LandofileService,
  RuntimeProviderRegistry,
} from "@lando/sdk/services";

import { resolveAgentEnvAudit } from "../../config/agent-env-policy.ts";
import { hostProxyPlanExtension } from "../../subsystems/host-proxy/plan-extension.ts";
import { type ResolvedAppTarget, loadUserLandofile, loadUserLandofileAt } from "../app-resolution.ts";
import { endpointUrl, formatAuthorityUrl, routeSchemes, routeUrl } from "../authority-url.ts";

export { buildInfoSummary, renderInfoAppResult } from "./info-render.ts";

export type { InfoAppError, InfoAppOptions, InfoAppResult, InfoAppService } from "@lando/sdk/app";

type InfoAppServices = AppPlanResolver | ConfigService | LandofileService | RuntimeProviderRegistry;

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

const endpointText = (service: ServicePlan, endpoint: EndpointPlan): ReadonlyArray<string> => {
  if (endpoint.socketPath !== undefined) return [`${endpoint.protocol}:${endpoint.socketPath}`];
  if (endpoint.port === undefined) return [endpoint.protocol];
  if (service.type === "postgres") {
    const user = service.environment.POSTGRES_USER ?? "lando";
    const database = service.environment.POSTGRES_DB ?? "postgres";
    const url = endpointUrl(endpoint, "postgresql");
    url.username = user;
    url.pathname = database;
    return [formatAuthorityUrl(url)];
  }
  if (service.type === "memcached" && endpoint.protocol === "tcp")
    return [formatAuthorityUrl(endpointUrl(endpoint, "memcached"))];
  if (service.type === "valkey" && endpoint.protocol === "tcp")
    return [
      formatAuthorityUrl(endpointUrl(endpoint, "valkey")),
      formatAuthorityUrl(endpointUrl(endpoint, "redis")),
    ];
  return [formatAuthorityUrl(endpointUrl(endpoint, endpoint.protocol))];
};

const routeText = (plan: AppPlan, service: ServicePlan): ReadonlyArray<string> =>
  plan.routes
    .filter((route) => route.service === service.name)
    .flatMap((route) =>
      routeSchemes(route, true).map((scheme) => formatAuthorityUrl(routeUrl(route, scheme))),
    );

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

// Requires only RuntimeProviderRegistry (no LandofileService/AppPlanResolver) so
// out-of-band plan resolvers (global-app commands) reuse this without pulling
// user-Landofile resolution into their bootstrap layer.
export const infoForPlan = (
  plan: AppPlan,
): Effect.Effect<InfoAppResult, InfoAppError, RuntimeProviderRegistry> =>
  Effect.gen(function* () {
    const registry = yield* RuntimeProviderRegistry;
    const provider = yield* registry.select(plan);

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
                  ...routeText(plan, service),
                  ...(runtime.endpoints ?? service.endpoints).flatMap((endpoint) =>
                    endpointText(service, endpoint),
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
    const planner = yield* AppPlanResolver;

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
      plan = yield* planner.plan(landofile, capabilities, { kind: "user" });
    }

    const result = yield* infoForPlan(plan);
    if (options?.deep !== true) return result;
    const agentEnv = yield* resolveAgentEnvAudit(landofile?.agentEnv, process.env);
    return { ...result, agentEnv };
  });
