import { Effect } from "effect";

import type {
  CapabilityError,
  GlobalAppError,
  GlobalDistConflictError,
  GlobalLandofilePathConflictError,
  GlobalServiceCollisionError,
  LandofileParseError,
  LandofileValidationError,
  NoProviderInstalledError,
  NotImplementedError,
  PluginManifestError,
  ProviderConfigError,
  ProviderUnavailableError,
} from "@lando/sdk/errors";
import type { AppPlan, EndpointPlan, ServicePlan } from "@lando/sdk/schema";
import {
  type AppPlanner,
  type FileSystem,
  type FileSystemError,
  type GlobalAppService,
  type PluginRegistry,
  type ProviderError,
  RuntimeProviderRegistry,
} from "@lando/sdk/services";

import { globalInstall } from "./global-install.ts";
import { loadGlobalPlan } from "./global-plan.ts";

export interface GlobalStartOptions {
  readonly services?: ReadonlyArray<string>;
  readonly signal?: AbortSignal;
}

export interface GlobalStartedService {
  readonly name: string;
  readonly state: string;
  readonly endpoints: ReadonlyArray<string>;
}

export interface GlobalStartResult {
  readonly app: string;
  readonly servicesStarted: ReadonlyArray<GlobalStartedService>;
}

type GlobalStartError =
  | CapabilityError
  | FileSystemError
  | GlobalAppError
  | GlobalDistConflictError
  | GlobalLandofilePathConflictError
  | GlobalServiceCollisionError
  | LandofileParseError
  | LandofileValidationError
  | NoProviderInstalledError
  | NotImplementedError
  | PluginManifestError
  | ProviderConfigError
  | ProviderError
  | ProviderUnavailableError;

type GlobalStartServices =
  | AppPlanner
  | FileSystem
  | GlobalAppService
  | PluginRegistry
  | RuntimeProviderRegistry;

const selectedServices = (
  plan: AppPlan,
  requested: ReadonlyArray<string> | undefined,
): ReadonlyArray<ServicePlan> => {
  const services = Object.values(plan.services);
  if (requested === undefined || requested.length === 0) return services;
  const ids = new Set(requested.filter((service) => service.length > 0));
  return services.filter((service) => ids.has(String(service.name)));
};

const endpointText = (endpoint: EndpointPlan): string => {
  if (endpoint.socketPath !== undefined) return `${endpoint.protocol}:${endpoint.socketPath}`;
  if (endpoint.port === undefined) return endpoint.protocol;
  return `${endpoint.protocol}://localhost:${endpoint.port}`;
};

const READY_STATES = new Set(["running", "ready"]);

const isGlobalStartReady = (result: GlobalStartResult): boolean =>
  result.servicesStarted.length > 0 &&
  result.servicesStarted.every((service) => READY_STATES.has(service.state));

export const renderGlobalStartResult = (result: GlobalStartResult): string => {
  const services = result.servicesStarted
    .map((service) => {
      const endpoints = service.endpoints.length === 0 ? "no endpoints" : service.endpoints.join(", ");
      return `${service.name} (${service.state}) ${endpoints}`;
    })
    .join("; ");
  const prefix = isGlobalStartReady(result) ? "ready" : "starting";
  return `${prefix}: ${result.app}${services.length === 0 ? "" : ` - ${services}`}`;
};

export const globalStart = (
  options: GlobalStartOptions = {},
): Effect.Effect<GlobalStartResult, GlobalStartError, GlobalStartServices> =>
  Effect.gen(function* () {
    yield* globalInstall({});
    const loaded = yield* loadGlobalPlan();
    if (!loaded.materialized) return { app: "global", servicesStarted: [] };

    const registry = yield* RuntimeProviderRegistry;
    const provider = yield* registry.select(loaded.plan);
    const services = selectedServices(loaded.plan, options.services);

    // With `--service`, start only the selected subset rather than the whole plan.
    const selectedNames = new Set(services.map((service) => String(service.name)));
    const planToApply =
      services.length === Object.keys(loaded.plan.services).length
        ? loaded.plan
        : {
            ...loaded.plan,
            services: Object.fromEntries(
              Object.entries(loaded.plan.services).filter(([, service]) =>
                selectedNames.has(String(service.name)),
              ),
            ),
          };

    yield* Effect.scoped(
      provider.apply(planToApply, {
        reconcile: false,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }),
    );

    const servicesStarted = yield* Effect.forEach(services, (service) =>
      provider.inspect({ app: loaded.plan.id, service: service.name, plan: loaded.plan }).pipe(
        Effect.map((runtime) => ({
          name: String(service.name),
          state: runtime.state ?? runtime.status,
          endpoints: (runtime.endpoints ?? service.endpoints).map(endpointText),
        })),
      ),
    );

    return { app: loaded.plan.name, servicesStarted };
  });
