import { type GlobalMutationServices, withGlobalMutation } from "@lando/engine/global-app/mutation";
import { DateTime, Effect, Schema } from "effect";

import { routerEnabled } from "@lando/engine/config/router-config";
import { completeStartup } from "@lando/engine/lifecycle/startup-completion";
import { collectObservedConnections, startedServices } from "@lando/engine/operations/connection-collector";
import { includeAvailableDependencies } from "@lando/engine/operations/ensure-global-services";

import { retainGlobalPlanSiblings } from "@lando/engine/operations/global-retained-plan";
import { applyGlobalServiceGroups } from "@lando/engine/operations/global-service-groups";
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
import { StartAppResult } from "@lando/sdk/schema";
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

export const GlobalStartResultSchema = Schema.Struct({
  app: StartAppResult.fields.app,
  servicesStarted: StartAppResult.fields.servicesStarted,
});
export type GlobalStartResult = typeof GlobalStartResultSchema.Type;

export type GlobalStartError =
  | Effect.Error<ReturnType<typeof globalInstall>>
  | Effect.Error<ReturnType<typeof retainGlobalPlanSiblings>>
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
  | GlobalMutationServices
  | import("@lando/sdk/services").StateStore
  | import("@lando/sdk/services").EnvironmentValueResolver
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

export const globalStart = Effect.fn("GlobalStart.start")(
  function* (
    options: GlobalStartOptions = {},
  ): Effect.fn.Return<GlobalStartResult, GlobalStartError, GlobalStartServices> {
    const selection = options.services === undefined ? {} : { services: options.services };
    yield* globalInstall(selection);
    const loaded = yield* loadGlobalPlan(selection);
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
    const provider = yield* registry.select(loaded.plan.provider);

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
        const retained = options.services?.length
          ? yield* retainGlobalPlanSiblings(
              loaded.plan,
              provider,
              services.map((service) => String(service.name)),
            )
          : undefined;
        const builds = yield* BuildOrchestrator;
        const applied = yield* applyGlobalServiceGroups(
          loaded.plan,
          {
            provider,
            services,
            ...(retained === undefined
              ? {}
              : { recordedPlan: retained.recordedPlan, recordedDisabledIds: retained.disabledIds }),
            options: {
              reconcile: false,
              ...(options.signal === undefined ? {} : { signal: options.signal }),
            },
          },
          (plan) => withBuildProvider(builds.build(plan), provider),
        );
        const outcome = yield* completeStartup({
          policy: "global-groups",
          operation: "start",
          provider,
          router,
          outcome: applied,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        const servicesStarted = startedServices(
          yield* collectObservedConnections(outcome.builtPlan, outcome.ready),
        );
        return { app: loaded.plan.name, servicesStarted };
      }),
    );
  },
  (effect, _options: GlobalStartOptions = {}) => withGlobalMutation(effect),
);
