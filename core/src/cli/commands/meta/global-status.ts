import { Effect, Schema } from "effect";

import {
  type ObservedService,
  collectObservedConnections,
  observeService,
} from "@lando/engine/operations/connection-collector";
import type { ToolingExecError } from "@lando/sdk/errors";
import { ServiceConnection, type ServicePlan, ServiceState } from "@lando/sdk/schema";
import {
  type AppPlanner,
  type FileSystem,
  type GlobalAppService,
  type ProviderError,
  RuntimeProviderRegistry,
} from "@lando/sdk/services";
import { selectGlobalServices } from "./global-common";

import {
  type LoadObservedGlobalPlanError,
  loadObservedGlobalPlan,
} from "@lando/engine/operations/global-plan";
import { linkKnownHttpUrls } from "@lando/renderer/console-layout";
import { type SummaryDocument, formatSummary, worstSummaryTone } from "@lando/renderer/summary";
import { type RenderContext, isDecoratedContext, summaryPaintOptions } from "../../renderer-boundary";
import { contextAllowsHyperlinks } from "../../renderer-boundary";
import { connectionFields, scopedConnectionText, unambiguousHostHttpUrls } from "../connection-summary";
import { INFO_STATUS_TONES, summaryToneFromTable } from "../service-summary";

export interface GlobalStatusOptions {
  readonly services?: ReadonlyArray<string>;
  readonly format?: "json" | "table";
}

export const GlobalStatusServiceSchema = Schema.Struct({
  app: Schema.String,
  service: Schema.String,
  api: Schema.Literal(4),
  type: Schema.String,
  provider: Schema.String,
  primary: Schema.Boolean,
  status: ServiceState,
  connections: Schema.Array(ServiceConnection),
});
export type GlobalStatusService = typeof GlobalStatusServiceSchema.Type;

export const GlobalStatusResultSchema = Schema.Struct({
  app: Schema.String,
  materialized: Schema.Boolean,
  services: Schema.Array(GlobalStatusServiceSchema),
});
export type GlobalStatusResult = typeof GlobalStatusResultSchema.Type;

type GlobalStatusError = LoadObservedGlobalPlanError | ProviderError | ToolingExecError;

type GlobalStatusServices = AppPlanner | FileSystem | GlobalAppService | RuntimeProviderRegistry;

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
      ...connectionFields(service.connections),
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
  if (isDecoratedContext(ctx)) {
    const text = formatSummary(buildGlobalStatusSummary(result), summaryPaintOptions(ctx));
    return contextAllowsHyperlinks(ctx)
      ? linkKnownHttpUrls(
          text,
          unambiguousHostHttpUrls(result.services.flatMap((service) => service.connections)),
        )
      : text;
  }
  if (!result.materialized) return "Global app is not installed.\n(no services)";
  if (result.services.length === 0) return `${result.app}\n(no services)`;
  const rows = result.services.map((service) => {
    return `${service.service}\t${service.status}\t${scopedConnectionText(service.connections, "host") || "not published"}\t${scopedConnectionText(service.connections, "app") || "-"}`;
  });
  return [`app\t${result.app}`, "service\tstate\tHost\tApp Network", ...rows].join("\n");
};

export const globalStatus = Effect.fn("GlobalStatus.status")(function* (
  options: GlobalStatusOptions = {},
): Effect.fn.Return<GlobalStatusResult, GlobalStatusError, GlobalStatusServices> {
  const loaded = yield* loadObservedGlobalPlan();
  if (!loaded.materialized) return { app: "global", materialized: false, services: [] };

  const registry = yield* RuntimeProviderRegistry;
  const degraded = (service: ServicePlan): ObservedService => ({
    name: String(service.name),
    state: "unknown",
    runtime: {
      app: loaded.plan.id,
      service: service.name,
      providerId: service.provider,
      status: "unknown",
      publications: { status: "unknown" },
    },
  });

  // Intentional: provider-unavailable degrades to "unknown" so status reports the materialized stack even when nothing is running.
  const inspectService = (service: ServicePlan): Effect.Effect<ObservedService> =>
    registry.select(loaded.plan).pipe(
      Effect.flatMap((provider) =>
        provider.inspect({ app: loaded.plan.id, service: service.name, plan: loaded.plan }),
      ),
      Effect.map((runtime) => observeService(loaded.plan, runtime)),
      Effect.catch(() => Effect.succeed(degraded(service))),
    );

  const selected = yield* selectGlobalServices({
    commandId: "meta:global:status",
    services: loaded.plan.services,
    requested: options.services,
    expandDependencies: false,
  });
  const observations = yield* Effect.forEach(selected, inspectService);
  const collected = yield* collectObservedConnections(loaded.plan, observations);
  const services = selected.map((service): GlobalStatusService => {
    const observed = collected.find((row) => row.name === String(service.name));
    return {
      app: String(loaded.plan.id),
      service: String(service.name),
      api: 4,
      type: service.type,
      provider: String(service.provider),
      primary: service.primary,
      status: observed?.state ?? "unknown",
      connections: observed?.connections ?? [],
    };
  });

  return { app: loaded.plan.name, materialized: true, services };
});
