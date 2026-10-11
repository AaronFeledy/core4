import { DateTime, Effect, Schema } from "effect";

import { startedServiceRow } from "@lando/engine/operations/authority-url";
import { applyGlobalRoutesForSelectedServices } from "@lando/engine/operations/global-routes";

import {
  applyGlobalServiceGroups,
  globalServiceGroupError,
} from "@lando/engine/operations/global-service-groups";
import { MANAGED_PROVIDER_SELECT_PLAN } from "@lando/engine/providers/managed";
import { withBuildProvider } from "@lando/engine/services/build-orchestrator";
import type {
  GlobalAppError,
  GlobalDistConflictError,
  GlobalLandofilePathConflictError,
  GlobalServiceCollisionError,
  PluginManifestError,
  ProviderConfigError,
  ProviderUnavailableError,
  ProxyApplyError,
  ProxySetupError,
  RouterPortPinMismatch,
  RouterPortsExhausted,
  RouterWatcherError,
  SecretNotFoundError,
  SecretReferenceInvalidError,
  SecretStoreUnavailableError,
} from "@lando/sdk/errors";
import type { ToolingExecError } from "@lando/sdk/errors";
import { PostGlobalStartEvent, PreGlobalStartEvent } from "@lando/sdk/events";
import {
  type AppPlanner,
  type BuildError,
  BuildOrchestrator,
  EventService,
  type FileSystem,
  type GlobalAppService,
  type PluginRegistry,
  type ProviderError,
  RouterService,
  RuntimeProviderRegistry,
} from "@lando/sdk/services";
import { joinServiceRows, lifecycleLine } from "../service-summary";
import {
  globalAppRef,
  renderGlobalServiceRow,
  selectGlobalServices,
  withGlobalLifecycleEvents,
} from "./global-common";

import { globalInstall } from "@lando/engine/operations/global-install";
import { type LoadGlobalPlanError, loadGlobalPlan } from "@lando/engine/operations/global-plan";

const now = () => DateTime.nowUnsafe();

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

export const GlobalStartedServiceSchema = Schema.Struct({
  name: Schema.String,
  state: Schema.String,
  endpoints: Schema.Array(Schema.String),
});

export const GlobalStartResultSchema = Schema.Struct({
  app: Schema.String,
  servicesStarted: Schema.Array(GlobalStartedServiceSchema),
});

export type GlobalStartError =
  | GlobalAppError
  | LoadGlobalPlanError
  | BuildError
  | GlobalDistConflictError
  | GlobalLandofilePathConflictError
  | GlobalServiceCollisionError
  | PluginManifestError
  | SecretNotFoundError
  | ProviderConfigError
  | ProviderError
  | ProviderUnavailableError
  | ProxyApplyError
  | ProxySetupError
  | RouterPortPinMismatch
  | RouterPortsExhausted
  | RouterWatcherError
  | SecretStoreUnavailableError
  | SecretReferenceInvalidError
  | ToolingExecError;

export type GlobalStartServices =
  | AppPlanner
  | BuildOrchestrator
  | EventService
  | FileSystem
  | GlobalAppService
  | PluginRegistry
  | RuntimeProviderRegistry
  | RouterService;

const READY_STATES = new Set(["running", "ready"]);

const isGlobalStartReady = (result: GlobalStartResult): boolean =>
  result.servicesStarted.length > 0 &&
  result.servicesStarted.every((service) => READY_STATES.has(service.state));

export const renderGlobalStartResult = (result: GlobalStartResult): string => {
  const services = joinServiceRows(result.servicesStarted.map(renderGlobalServiceRow));
  const prefix = isGlobalStartReady(result) ? "ready" : "starting";
  return lifecycleLine(prefix, result.app, services);
};

export const globalStart = Effect.fn("GlobalStart.start")(function* (
  options: GlobalStartOptions = {},
): Effect.fn.Return<GlobalStartResult, GlobalStartError, GlobalStartServices> {
  yield* globalInstall({});
  const loaded = yield* loadGlobalPlan();
  if (!loaded.materialized) return { app: "global", servicesStarted: [] };

  const services = yield* selectGlobalServices({
    commandId: "meta:global:start",
    services: loaded.plan.services,
    requested: options.services,
    expandDependencies: true,
  });
  const events = yield* EventService;
  const registry = yield* RuntimeProviderRegistry;
  const provider = yield* registry.select(MANAGED_PROVIDER_SELECT_PLAN);

  return yield* withGlobalLifecycleEvents(
    {
      pre: () =>
        events.publish(
          PreGlobalStartEvent.make({
            scope: "global",
            app: globalAppRef(loaded.plan),
            plan: loaded.plan,
            triggeredBy: "meta:global:start",
            ensuringServices: [],
            cached: false,
            timestamp: now(),
          }),
        ),
      post: () =>
        events.publish(
          PostGlobalStartEvent.make({
            scope: "global",
            app: globalAppRef(loaded.plan),
            plan: loaded.plan,
            cached: false,
            timestamp: now(),
          }),
        ),
    },
    Effect.gen(function* () {
      const builds = yield* BuildOrchestrator;
      const outcome = yield* applyGlobalServiceGroups(
        loaded.plan,
        {
          provider,
          services,
          options: {
            reconcile: false,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
          },
        },
        (plan) => withBuildProvider(builds.build(plan), provider),
      );
      const partialError = globalServiceGroupError("start", outcome);
      const selectedNames = new Set(outcome.services.map((service) => service.name));
      const failedNames = new Set(outcome.failures.flatMap((failure) => failure.names));
      const router = yield* RouterService;
      const applyRoutes = applyGlobalRoutesForSelectedServices(
        router,
        { ...loaded.plan, routes: loaded.plan.routes.filter((route) => !failedNames.has(route.service)) },
        selectedNames,
      );
      if (partialError !== undefined) {
        yield* Effect.result(applyRoutes);
        return yield* Effect.fail(partialError);
      }
      const routeUrls = yield* applyRoutes;
      const servicesStarted = yield* Effect.forEach(
        services.filter((service) => selectedNames.has(service.name)),
        (service) =>
          provider.inspect({ app: loaded.plan.id, service: service.name, plan: loaded.plan }).pipe(
            Effect.map((runtime) => {
              const row = startedServiceRow(service, runtime);
              return { ...row, endpoints: [...row.endpoints, ...(routeUrls.get(service.name) ?? [])] };
            }),
          ),
      );
      return { app: loaded.plan.name, servicesStarted };
    }),
  );
});
