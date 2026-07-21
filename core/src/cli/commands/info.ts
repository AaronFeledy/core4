import { Effect, Schema } from "effect";

import type {
  InfoAppError,
  InfoAppOptions,
  InfoAppResult,
  InfoAppService,
  InfoLogSource,
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
import { type RenderContext, isDecoratedContext } from "../renderer-boundary.ts";
import {
  type SummaryDocument,
  type SummaryRow,
  type SummaryTone,
  formatSummary,
  worstSummaryTone,
} from "../renderer/summary.ts";

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

type InfoResultWithHostProxy = InfoAppResult & {
  readonly hostProxy?: typeof AppInfoHostProxySchema.Type;
};

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
    return [`postgresql://${user}@localhost:${endpoint.port}/${database}`];
  }
  if (service.type === "memcached" && endpoint.protocol === "tcp")
    return [`memcached://localhost:${endpoint.port}`];
  if (service.type === "valkey" && endpoint.protocol === "tcp")
    return [`valkey://localhost:${endpoint.port}`, `redis://localhost:${endpoint.port}`];
  return [`${endpoint.protocol}://localhost:${endpoint.port}`];
};

const infoStatusTone = (status: InfoServiceStatus): SummaryTone => {
  switch (status) {
    case "running":
    case "healthy":
      return "ok";
    case "starting":
      return "pending";
    case "stopped":
      return "skipped";
    case "unhealthy":
    case "error":
      return "error";
    default:
      return "info";
  }
};

const logSourceText = (source: InfoLogSource): string => {
  const availability =
    source.reason === undefined ? source.availability : `${source.availability}: ${source.reason}`;
  return `${source.id} ${source.path} (${source.strategy}, ${availability})`;
};

export const buildInfoSummary = (result: InfoAppResult): SummaryDocument => {
  const hostProxy = (result as InfoResultWithHostProxy).hostProxy;
  const rows: SummaryRow[] = result.services.map((service) => ({
    label: service.service,
    tone: infoStatusTone(service.status),
    value: service.status,
    fields: [
      { label: "type", value: service.type },
      { label: "provider", value: service.provider },
      {
        label: "endpoints",
        value: service.endpoints.length === 0 ? "no endpoints" : service.endpoints.join(", "),
      },
      ...(service.logSources === undefined
        ? []
        : [{ label: "log sources", value: service.logSources.map(logSourceText).join(", ") }]),
    ],
  }));
  const agentEnvSection =
    result.agentEnv === undefined
      ? []
      : [
          {
            title: "agent env",
            rows: [
              {
                label: "forwarding",
                tone: (result.agentEnv.enabled ? "ok" : "skipped") as SummaryTone,
                value: result.agentEnv.enabled ? "enabled" : "disabled",
                fields: [
                  {
                    label: "forwarded",
                    value:
                      result.agentEnv.forwarded.length === 0
                        ? "(none)"
                        : result.agentEnv.forwarded.join(", "),
                  },
                ],
              },
            ],
          },
        ];
  return {
    title: "APP INFO",
    subtitle: result.app,
    tone: result.services.length === 0 ? "info" : worstSummaryTone(rows.map((row) => row.tone ?? "info")),
    sections: [
      {
        title: "services",
        rows,
        ...(rows.length === 0 ? { notes: ["No services are defined for this app."] } : {}),
      },
      ...(hostProxy === undefined
        ? []
        : [
            {
              title: "host-proxy",
              rows: [
                {
                  label: "runLando",
                  tone: (hostProxy.runLando.availability === "available" ? "ok" : "skipped") as SummaryTone,
                  value: hostProxy.runLando.availability,
                  fields:
                    hostProxy.runLando.reason === undefined
                      ? []
                      : [{ label: "reason", value: hostProxy.runLando.reason }],
                },
              ],
            },
          ]),
      ...agentEnvSection,
    ],
    footer: `${result.services.length} services`,
  };
};

const agentEnvLines = (result: InfoAppResult): ReadonlyArray<string> => {
  if (result.agentEnv === undefined) return [];
  const forwarded = result.agentEnv.forwarded.length === 0 ? "(none)" : result.agentEnv.forwarded.join(", ");
  return [`agent-env\t${result.agentEnv.enabled ? "enabled" : "disabled"}\t${forwarded}`];
};

const hostProxyLines = (result: InfoAppResult): ReadonlyArray<string> => {
  const hostProxy = (result as InfoResultWithHostProxy).hostProxy;
  if (hostProxy === undefined) return [];
  const reason = hostProxy.runLando.reason === undefined ? "" : `\t${hostProxy.runLando.reason}`;
  return [`host-proxy\trunLando\t${hostProxy.runLando.availability}${reason}`];
};

export const renderInfoAppResult = (result: InfoAppResult, ctx?: RenderContext): string => {
  if (isDecoratedContext(ctx)) return formatSummary(buildInfoSummary(result), { columns: ctx?.columns });
  const extra = [...hostProxyLines(result), ...agentEnvLines(result)];
  if (result.services.length === 0) return [`${result.app}`, "(no services)", ...extra].join("\n");
  const rows = result.services.flatMap((service) => {
    const endpoints = service.endpoints;
    const renderedEndpoints = endpoints.length === 0 ? "no endpoints" : endpoints.join(", ");
    const base = `${service.service}\t${service.status}\t${renderedEndpoints}`;
    const logRows = (service.logSources ?? []).map((source) => {
      const reason = source.reason === undefined ? "" : `\t${source.reason}`;
      return `${service.service}\tlog-source\t${source.id}\t${source.path}\t${source.strategy}\t${source.availability}${reason}`;
    });
    return [base, ...logRows];
  });
  return [`app\t${result.app}`, "service\tstate\tendpoints", ...rows, ...extra].join("\n");
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
              : (runtime.endpoints ?? service.endpoints).flatMap((endpoint) =>
                  endpointText(service, endpoint),
                ),
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
