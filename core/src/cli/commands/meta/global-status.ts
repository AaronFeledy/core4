import { Effect, Schema } from "effect";

import { publishedEndpointUrls } from "@lando/engine/operations/authority-url";
import type { ToolingExecError } from "@lando/sdk/errors";
import type { ServicePlan } from "@lando/sdk/schema";
import {
  type AppPlanner,
  type FileSystem,
  type GlobalAppService,
  type ProviderError,
  RuntimeProviderRegistry,
} from "@lando/sdk/services";
import { selectGlobalServices } from "./global-common";

import { type LoadGlobalPlanError, loadGlobalPlan } from "@lando/engine/operations/global-plan";
import { type SummaryDocument, formatSummary, worstSummaryTone } from "@lando/renderer/summary";
import { type RenderContext, isDecoratedContext, summaryPaintOptions } from "../../renderer-boundary";
import { INFO_STATUS_TONES, endpointText, summaryToneFromTable } from "../service-summary";

export interface GlobalStatusOptions {
  readonly services?: ReadonlyArray<string>;
  readonly format?: "json" | "table";
}

type GlobalServiceStatus = "unknown" | "stopped" | "starting" | "running" | "healthy" | "unhealthy" | "error";

export interface GlobalStatusService {
  readonly app: string;
  readonly service: string;
  readonly api: 4;
  readonly type: string;
  readonly provider: string;
  readonly primary: boolean;
  readonly status: GlobalServiceStatus;
  readonly endpoints: ReadonlyArray<string>;
}

export const GlobalStatusServiceSchema = Schema.Struct({
  app: Schema.String,
  service: Schema.String,
  api: Schema.Literal(4),
  type: Schema.String,
  provider: Schema.String,
  primary: Schema.Boolean,
  status: Schema.Literals(["unknown", "stopped", "starting", "running", "healthy", "unhealthy", "error"]),
  endpoints: Schema.Array(Schema.String),
});

export interface GlobalStatusResult {
  readonly app: string;
  readonly materialized: boolean;
  readonly services: ReadonlyArray<GlobalStatusService>;
}

export const GlobalStatusResultSchema = Schema.Struct({
  app: Schema.String,
  materialized: Schema.Boolean,
  services: Schema.Array(GlobalStatusServiceSchema),
});

type GlobalStatusError = LoadGlobalPlanError | ProviderError | ToolingExecError;

type GlobalStatusServices = AppPlanner | FileSystem | GlobalAppService | RuntimeProviderRegistry;

const statusText = (status: string | undefined): GlobalServiceStatus => {
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

const globalStatusTone = summaryToneFromTable(INFO_STATUS_TONES, "info");

export const buildGlobalStatusSummary = (result: GlobalStatusResult): SummaryDocument => {
  if (!result.materialized) {
    return {
      title: "GLOBAL APP",
      tone: "info",
      sections: [{ title: "status", rows: [], notes: ["Global app is not installed."] }],
      footer: "not installed",
    };
  }
  const rows = result.services.map((service) => ({
    label: service.service,
    tone: globalStatusTone(service.status),
    value: service.status,
    fields: [
      { label: "type", value: service.type },
      { label: "provider", value: service.provider },
      {
        label: "endpoints",
        value: endpointText(service.endpoints),
      },
    ],
  }));
  return {
    title: "GLOBAL APP",
    subtitle: result.app,
    tone: rows.length === 0 ? "info" : worstSummaryTone(rows.map((row) => row.tone)),
    sections: [
      {
        title: "services",
        rows,
        ...(rows.length === 0 ? { notes: ["No global services are running."] } : {}),
      },
    ],
    footer: `${result.services.length} services`,
  };
};

export const renderGlobalStatusResult = (
  result: GlobalStatusResult,
  _format: "json" | "table" = "table",
  ctx?: RenderContext,
): string => {
  void _format;
  if (isDecoratedContext(ctx))
    return formatSummary(buildGlobalStatusSummary(result), summaryPaintOptions(ctx));
  if (!result.materialized) return "Global app is not installed.\n(no services)";
  if (result.services.length === 0) return `${result.app}\n(no services)`;
  const rows = result.services.map((service) => {
    const endpoints = endpointText(service.endpoints);
    return `${service.service}\t${service.status}\t${endpoints}`;
  });
  return [`app\t${result.app}`, "service\tstate\tendpoints", ...rows].join("\n");
};

export const globalStatus = Effect.fn("GlobalStatus.status")(function* (
  options: GlobalStatusOptions = {},
): Effect.fn.Return<GlobalStatusResult, GlobalStatusError, GlobalStatusServices> {
  const loaded = yield* loadGlobalPlan();
  if (!loaded.materialized) return { app: "global", materialized: false, services: [] };

  const registry = yield* RuntimeProviderRegistry;
  const degraded = (service: ServicePlan): GlobalStatusService => ({
    app: String(loaded.plan.id),
    service: String(service.name),
    api: 4 as const,
    type: service.type,
    provider: String(service.provider),
    primary: service.primary,
    status: "unknown",
    endpoints: publishedEndpointUrls(service.endpoints),
  });

  // Intentional: provider-unavailable degrades to "unknown" so status reports the materialized stack even when nothing is running.
  const inspectService = (service: ServicePlan): Effect.Effect<GlobalStatusService, never, never> =>
    registry.select(loaded.plan).pipe(
      Effect.flatMap((provider) =>
        provider.inspect({ app: loaded.plan.id, service: service.name, plan: loaded.plan }),
      ),
      Effect.map((runtime): GlobalStatusService => {
        const status = statusText(runtime.state ?? runtime.status);
        return {
          app: String(loaded.plan.id),
          service: String(service.name),
          api: 4 as const,
          type: service.type,
          provider: String(service.provider),
          primary: service.primary,
          status,
          endpoints:
            status === "stopped" ? [] : publishedEndpointUrls(runtime.endpoints ?? service.endpoints),
        };
      }),
      Effect.catch(() => Effect.succeed(degraded(service))),
    );

  const selected = yield* selectGlobalServices({
    commandId: "meta:global:status",
    services: loaded.plan.services,
    requested: options.services,
    expandDependencies: false,
  });
  const services = yield* Effect.forEach(selected, inspectService);

  return { app: loaded.plan.name, materialized: true, services };
});
