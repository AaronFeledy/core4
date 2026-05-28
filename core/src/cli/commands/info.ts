/**
 * `lando info` — provider-neutral runtime info.
 *
 * Supports `--deep`, repeated `--filter`, `--path`, `--service`,
 * `--format json|table|yaml`.
 */
import { Effect } from "effect";

import type {
  CapabilityError,
  LandoCommandError,
  LandofileNotFoundError,
  LandofileParseError,
  LandofileSandboxError,
  LandofileTimeoutError,
  LandofileValidationError,
  NoProviderInstalledError,
  NotImplementedError,
  ProviderConfigError,
  ProviderUnavailableError,
} from "@lando/sdk/errors";
import type { AppPlan, EndpointPlan, ServicePlan } from "@lando/sdk/schema";
import {
  AppPlanner,
  LandofileService,
  type ProviderError,
  RuntimeProviderRegistry,
} from "@lando/sdk/services";

export interface InfoAppOptions {
  readonly deep?: boolean;
  readonly service?: string;
  readonly path?: string;
  readonly filters?: ReadonlyArray<string>;
}

type InfoServiceStatus = "unknown" | "stopped" | "starting" | "running" | "healthy" | "unhealthy" | "error";

export interface InfoAppService {
  readonly app: string;
  readonly service: string;
  readonly api: 4;
  readonly type: string;
  readonly provider: string;
  readonly primary: boolean;
  readonly status: InfoServiceStatus;
  readonly endpoints: ReadonlyArray<string>;
}

export interface InfoAppResult {
  readonly app: string;
  readonly services: ReadonlyArray<InfoAppService>;
}

type InfoAppError =
  | LandofileNotFoundError
  | LandofileParseError
  | LandofileSandboxError
  | LandofileTimeoutError
  | LandofileValidationError
  | NotImplementedError
  | CapabilityError
  | LandoCommandError
  | NoProviderInstalledError
  | ProviderConfigError
  | ProviderError
  | ProviderUnavailableError;

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

const endpointText = (service: ServicePlan, endpoint: EndpointPlan): string => {
  if (endpoint.socketPath !== undefined) return `${endpoint.protocol}:${endpoint.socketPath}`;
  if (endpoint.port === undefined) return endpoint.protocol;
  if (service.type === "postgres") {
    const user = service.environment.POSTGRES_USER ?? "lando";
    const database = service.environment.POSTGRES_DB ?? "postgres";
    return `postgresql://${user}@localhost:${endpoint.port}/${database}`;
  }
  if (service.type === "memcached" && endpoint.protocol === "tcp")
    return `memcached://localhost:${endpoint.port}`;
  return `${endpoint.protocol}://localhost:${endpoint.port}`;
};

export const renderInfoAppResult = (result: InfoAppResult): string => {
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
): Effect.Effect<InfoAppResult, InfoAppError, InfoAppServices> =>
  Effect.gen(function* () {
    const landofileService = yield* LandofileService;
    const registry = yield* RuntimeProviderRegistry;
    const planner = yield* AppPlanner;

    const landofile = yield* landofileService.discover;
    const capabilities = yield* registry.capabilities;
    const plan = yield* planner.plan(landofile, capabilities);
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
              : (runtime.endpoints ?? service.endpoints).map((endpoint) => endpointText(service, endpoint)),
          );
        }),
      ),
    );

    return { app: plan.name, services };
  });
