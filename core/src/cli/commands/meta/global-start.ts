import { DateTime, Effect, Schema } from "effect";

import { routerEnabled } from "@lando/engine/config/router-config";
import { includeAvailableDependencies } from "@lando/engine/operations/ensure-global-services";
import { publishGlobalRoutes } from "@lando/engine/operations/global-routes";
import { waitForServiceReadiness } from "@lando/engine/operations/service-readiness";

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
  SecretNotFoundError,
  SecretReferenceInvalidError,
  SecretStoreUnavailableError,
  ServiceNotReadyError,
} from "@lando/sdk/errors";
import type { ToolingExecError } from "@lando/sdk/errors";
import { PostGlobalStartEvent, PreGlobalStartEvent } from "@lando/sdk/events";
import { ServiceName } from "@lando/sdk/schema";
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
  | ServiceNotReadyError
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

export const renderGlobalStartResult = (result: GlobalStartResult): string => {
  const services = joinServiceRows(result.servicesStarted.map(renderGlobalServiceRow));
  return lifecycleLine("ready", result.app, services);
};

export const globalStart = Effect.fn("GlobalStart.start")(function* (
  options: GlobalStartOptions = {},
): Effect.fn.Return<GlobalStartResult, GlobalStartError, GlobalStartServices> {
  yield* globalInstall({});
  const loaded = yield* loadGlobalPlan();
  if (!loaded.materialized) return { app: "global", servicesStarted: [] };

  const router = yield* RouterService;
  let services = yield* selectGlobalServices({
    commandId: "meta:global:start",
    services: loaded.plan.services,
    requested: options.services,
    expandDependencies: true,
  });
  const available = Object.values(loaded.plan.services);
  if (
    (options.services?.length ?? 0) > 0 &&
    routerEnabled(loaded.plan) &&
    available.some((service) => service.name === router.id) &&
    loaded.plan.routes.some((route) => services.some((service) => service.name === route.service))
  ) {
    const selected = includeAvailableDependencies(
      [...services.map((service) => service.name), router.id],
      available,
    );
    services = available.filter((service) => selected.has(service.name));
  }
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
      const applyRoutes = publishGlobalRoutes(router, provider, loaded.plan, {
        started: selectedNames,
        failed: failedNames,
      });
      if (partialError !== undefined) {
        yield* Effect.result(applyRoutes);
        return yield* Effect.fail(partialError);
      }
      const routeUrls = yield* applyRoutes;
      const ready = yield* waitForServiceReadiness({
        provider,
        plan: outcome.builtPlan,
        services: outcome.services.map((service) => service.name),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      const servicesStarted = ready.map((row) => ({
        ...row,
        endpoints: [...row.endpoints, ...(routeUrls.get(ServiceName.make(row.name)) ?? [])],
      }));
      return { app: loaded.plan.name, servicesStarted };
    }),
  );
});
