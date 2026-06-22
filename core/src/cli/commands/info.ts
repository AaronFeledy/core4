/**
 * `lando info` — provider-neutral runtime info.
 *
 * Supports `--deep`, repeated `--filter`, `--path`, `--service`,
 * `--format json|table|yaml`.
 */
import { Effect } from "effect";

import type {
  InfoAppError,
  InfoAppOptions,
  InfoAppResult,
  InfoAppService,
  InfoServiceStatus,
} from "@lando/sdk/app";
import type { AppPlan, EndpointPlan, ServicePlan } from "@lando/sdk/schema";
import { AppPlanner, LandofileService, RuntimeProviderRegistry } from "@lando/sdk/services";

import { type ResolvedAppTarget, loadUserLandofile } from "../app-resolution.ts";
import { type RenderContext, isDecoratedContext } from "../renderer-boundary.ts";
import {
  type SummaryDocument,
  type SummaryRow,
  type SummaryTone,
  formatSummary,
  worstSummaryTone,
} from "../renderer/summary.ts";

export type { InfoAppError, InfoAppOptions, InfoAppResult, InfoAppService } from "@lando/sdk/app";

type InfoAppServices = AppPlanner | LandofileService | RuntimeProviderRegistry;

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

export const buildInfoSummary = (result: InfoAppResult): SummaryDocument => {
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
    ],
  }));
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
    ],
    footer: `${result.services.length} services`,
  };
};

export const renderInfoAppResult = (result: InfoAppResult, ctx?: RenderContext): string => {
  if (isDecoratedContext(ctx)) return formatSummary(buildInfoSummary(result), { columns: ctx?.columns });
  if (result.services.length === 0) return `${result.app}\n(no services)`;
  const rows = result.services.map((service) => {
    const endpoints = service.endpoints;
    const renderedEndpoints = endpoints.length === 0 ? "no endpoints" : endpoints.join(", ");
    return `${service.service}\t${service.status}\t${renderedEndpoints}`;
  });
  return [`app\t${result.app}`, "service\tstate\tendpoints", ...rows].join("\n");
};

const toServiceInfo = (
  plan: AppPlan,
  service: ServicePlan,
  status: InfoServiceStatus,
  endpoints: ReadonlyArray<string>,
): InfoAppService => ({
  app: String(plan.id),
  service: String(service.name),
  api: 4,
  type: service.type,
  provider: String(service.provider),
  primary: service.primary,
  status,
  endpoints,
});

export const infoApp = (
  _options?: InfoAppOptions,
  target?: ResolvedAppTarget,
): Effect.Effect<InfoAppResult, InfoAppError, InfoAppServices> =>
  Effect.gen(function* () {
    const landofileService = yield* LandofileService;
    const registry = yield* RuntimeProviderRegistry;
    const planner = yield* AppPlanner;

    const plan =
      target?.plan ??
      (yield* Effect.gen(function* () {
        const landofile = yield* loadUserLandofile(landofileService);
        const capabilities = yield* registry.capabilities;
        return yield* planner.plan(landofile, capabilities);
      }));
    const provider = yield* registry.select(plan);

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
          );
        }),
      ),
    );

    return { app: plan.name, services };
  });
