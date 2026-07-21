import { DateTime, Effect, Schema } from "effect";

import type {
  CapabilityError,
  EventError,
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
import { PostGlobalRebuildEvent, PreGlobalRebuildEvent } from "@lando/sdk/events";
import type { AppPlan, AppRef, EndpointPlan } from "@lando/sdk/schema";
import {
  type AppPlanResolver,
  BuildOrchestrator,
  EventService,
  type FileSystem,
  type FileSystemError,
  type GlobalAppService,
  type PluginRegistry,
  type ProviderError,
  RuntimeProviderRegistry,
} from "@lando/sdk/services";

import { globalInstall } from "./global-install.ts";
import { type LoadGlobalPlanError, loadGlobalPlan } from "./global-plan.ts";

const now = () => DateTime.unsafeMake(new Date().toISOString());

const globalAppRef = (plan: AppPlan): AppRef => ({ kind: "global", id: plan.id, root: plan.root });

export interface GlobalRebuildOptions {
  readonly signal?: AbortSignal;
}

export interface GlobalRebuiltService {
  readonly name: string;
  readonly state: string;
  readonly endpoints: ReadonlyArray<string>;
}

export interface GlobalRebuildResult {
  readonly app: string;
  readonly materialized: boolean;
  readonly servicesRebuilt: ReadonlyArray<GlobalRebuiltService>;
}

export const GlobalRebuiltServiceSchema = Schema.Struct({
  name: Schema.String,
  state: Schema.String,
  endpoints: Schema.Array(Schema.String),
});

export const GlobalRebuildResultSchema = Schema.Struct({
  app: Schema.String,
  materialized: Schema.Boolean,
  servicesRebuilt: Schema.Array(GlobalRebuiltServiceSchema),
});

export type GlobalRebuildError =
  | CapabilityError
  | EventError
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
  | ProviderUnavailableError
  | LoadGlobalPlanError;

export type GlobalRebuildServices =
  | AppPlanResolver
  | BuildOrchestrator
  | EventService
  | FileSystem
  | GlobalAppService
  | PluginRegistry
  | RuntimeProviderRegistry;

const endpointText = (endpoint: EndpointPlan): string => {
  if (endpoint.socketPath !== undefined) return `${endpoint.protocol}:${endpoint.socketPath}`;
  if (endpoint.port === undefined) return endpoint.protocol;
  return `${endpoint.protocol}://localhost:${endpoint.port}`;
};

export const globalRebuild = (
  options: GlobalRebuildOptions = {},
): Effect.Effect<GlobalRebuildResult, GlobalRebuildError, GlobalRebuildServices> =>
  Effect.gen(function* () {
    yield* globalInstall({});
    const loaded = yield* loadGlobalPlan();
    if (!loaded.materialized) return { app: "global", materialized: false, servicesRebuilt: [] };

    const services = Object.values(loaded.plan.services);
    if (services.length === 0) return { app: loaded.plan.name, materialized: true, servicesRebuilt: [] };

    const registry = yield* RuntimeProviderRegistry;
    const provider = yield* registry.select(loaded.plan);
    const events = yield* EventService;
    const builder = yield* BuildOrchestrator;

    yield* events.publish(
      PreGlobalRebuildEvent.make({
        scope: "global",
        app: globalAppRef(loaded.plan),
        plan: loaded.plan,
        timestamp: now(),
      }),
    );

    yield* provider.destroy(
      { app: loaded.plan.id, plan: loaded.plan },
      { volumes: false, removeState: false },
    );

    const builtPlan = yield* builder.build(loaded.plan);
    yield* Effect.scoped(
      provider.apply(builtPlan, {
        reconcile: true,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }),
    );

    const servicesRebuilt = yield* Effect.forEach(Object.values(builtPlan.services), (service) =>
      provider.inspect({ app: builtPlan.id, service: service.name, plan: builtPlan }).pipe(
        Effect.map((runtime) => ({
          name: String(service.name),
          state: runtime.state ?? runtime.status,
          endpoints: (runtime.endpoints ?? service.endpoints).map(endpointText),
        })),
      ),
    );

    yield* events.publish(
      PostGlobalRebuildEvent.make({
        scope: "global",
        app: globalAppRef(builtPlan),
        plan: builtPlan,
        services: servicesRebuilt.map((service) => service.name),
        timestamp: now(),
      }),
    );

    return { app: builtPlan.name, materialized: true, servicesRebuilt };
  });

export const renderGlobalRebuildResult = (result: GlobalRebuildResult): string => {
  if (!result.materialized) return "global app is not installed";
  if (result.servicesRebuilt.length === 0) return `rebuilt: ${result.app} - no services`;
  const services = result.servicesRebuilt
    .map((service) => {
      const endpoints = service.endpoints.length === 0 ? "no endpoints" : service.endpoints.join(", ");
      return `${service.name} (${service.state}) ${endpoints}`;
    })
    .join("; ");
  return `rebuilt: ${result.app} - ${services}`;
};
