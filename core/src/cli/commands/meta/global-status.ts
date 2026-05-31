import { Effect } from "effect";

import type {
  CapabilityError,
  GlobalAppError,
  LandofileParseError,
  LandofileValidationError,
  NoProviderInstalledError,
  NotImplementedError,
  ProviderConfigError,
  ProviderUnavailableError,
} from "@lando/sdk/errors";
import { ToolingExecError } from "@lando/sdk/errors";
import type { AppPlan, EndpointPlan, ServicePlan } from "@lando/sdk/schema";
import {
  type AppPlanner,
  type FileSystem,
  type FileSystemError,
  type GlobalAppService,
  type ProviderError,
  RuntimeProviderRegistry,
} from "@lando/sdk/services";

import { loadGlobalPlan } from "./global-plan.ts";

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

export interface GlobalStatusResult {
  readonly app: string;
  readonly materialized: boolean;
  readonly services: ReadonlyArray<GlobalStatusService>;
}

type GlobalStatusError =
  | CapabilityError
  | FileSystemError
  | GlobalAppError
  | LandofileParseError
  | LandofileValidationError
  | NoProviderInstalledError
  | NotImplementedError
  | ProviderConfigError
  | ProviderError
  | ProviderUnavailableError
  | ToolingExecError;

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

const availableServiceList = (services: AppPlan["services"]): string =>
  Object.values(services)
    .map((service) => String(service.name))
    .sort()
    .join(", ");

const unknownServiceError = (requested: string, services: AppPlan["services"]): ToolingExecError => {
  const list = availableServiceList(services);
  return new ToolingExecError({
    message:
      list.length === 0
        ? `meta:global:status: service ${requested} is not in the global app plan.`
        : `meta:global:status: service ${requested} is not in the global app plan (available: ${list}).`,
    tool: "meta:global:status",
  });
};

const selectedServices = (
  plan: AppPlan,
  requested: ReadonlyArray<string> | undefined,
): Effect.Effect<ReadonlyArray<ServicePlan>, ToolingExecError> => {
  const services = Object.values(plan.services);
  if (requested === undefined || requested.length === 0) return Effect.succeed(services);

  const ids = new Set(requested);
  const matched = services.filter((service) => ids.has(String(service.name)));
  const matchedIds = new Set(matched.map((service) => String(service.name)));
  const missing = [...ids].find((service) => !matchedIds.has(service));

  if (missing !== undefined) return Effect.fail(unknownServiceError(missing, plan.services));
  return Effect.succeed(matched);
};

const endpointText = (endpoint: EndpointPlan): string => {
  if (endpoint.socketPath !== undefined) return `${endpoint.protocol}:${endpoint.socketPath}`;
  if (endpoint.port === undefined) return endpoint.protocol;
  return `${endpoint.protocol}://localhost:${endpoint.port}`;
};

const jsonReplacer = (_key: string, value: unknown): unknown =>
  typeof value === "bigint" ? value.toString() : value;

export const renderGlobalStatusResult = (
  result: GlobalStatusResult,
  format: "json" | "table" = "table",
): string => {
  if (format === "json") return JSON.stringify(result, jsonReplacer, 2);
  if (!result.materialized) return "Global app is not installed.\n(no services)";
  if (result.services.length === 0) return `${result.app}\n(no services)`;
  const rows = result.services.map((service) => {
    const endpoints = service.endpoints.length === 0 ? "no endpoints" : service.endpoints.join(", ");
    return `${service.service}\t${service.status}\t${endpoints}`;
  });
  return [`app\t${result.app}`, "service\tstate\tendpoints", ...rows].join("\n");
};

export const globalStatus = (
  options: GlobalStatusOptions = {},
): Effect.Effect<GlobalStatusResult, GlobalStatusError, GlobalStatusServices> =>
  Effect.gen(function* () {
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
      endpoints: service.endpoints.map(endpointText),
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
            endpoints: status === "stopped" ? [] : (runtime.endpoints ?? service.endpoints).map(endpointText),
          };
        }),
        Effect.catchAll(() => Effect.succeed(degraded(service))),
      );

    const selected = yield* selectedServices(loaded.plan, options.services);
    const services = yield* Effect.forEach(selected, inspectService);

    return { app: loaded.plan.name, materialized: true, services };
  });
