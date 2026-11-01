import { type GlobalMutationServices, withGlobalMutation } from "@lando/engine/global-app/mutation";
import { DateTime, Effect, Schema } from "effect";

import { routerEnabled } from "@lando/engine/config/router-config";
import { recordGlobalRouterStartupPlan } from "@lando/engine/global-app/router-admission";
import { captureGlobalStartupAdmission } from "@lando/engine/global-app/startup-admission";
import { completeStartup } from "@lando/engine/lifecycle/startup-completion";
import { collectObservedConnections, startedServices } from "@lando/engine/operations/connection-collector";
import { includeAvailableDependencies } from "@lando/engine/operations/ensure-global-services";

import { retainGlobalPlanSiblings } from "@lando/engine/operations/global-retained-plan";
import { applyGlobalServiceGroups } from "@lando/engine/operations/global-service-groups";
import { withBuildProvider } from "@lando/engine/services/build-orchestrator";
import type {
  DebuggerHostUnavailableError,
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
import { globalAppRef, selectGlobalServices, withGlobalLifecycleEvents } from "./global-common";

import { installAndLoadGlobalPlan } from "@lando/engine/operations/global-install";
import type { LoadGlobalPlanError } from "@lando/engine/operations/global-plan";

const now = () => DateTime.nowUnsafe();

export interface GlobalStartOptions {
  readonly services?: ReadonlyArray<string>;
  readonly signal?: AbortSignal;
  /** A debugger address already resolved by a caller that must not resolve after stopping services. */
  readonly resolvedDebuggerHost?: { readonly address: string | undefined };
}

export const GlobalStartResultSchema = Schema.Struct({
  app: StartAppResult.fields.app,
  servicesStarted: StartAppResult.fields.servicesStarted,
});
export type GlobalStartResult = typeof GlobalStartResultSchema.Type;

export type GlobalStartError =
  | Effect.Error<ReturnType<typeof installAndLoadGlobalPlan>>
  | Effect.Error<ReturnType<typeof retainGlobalPlanSiblings>>
  | ServiceNotReadyError
  | GlobalAppError
  | LoadGlobalPlanError
  | BuildError
  | DebuggerHostUnavailableError
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

export const globalStart = Effect.fn("GlobalStart.start")(
  function* (
    options: GlobalStartOptions = {},
  ): Effect.fn.Return<GlobalStartResult, GlobalStartError, GlobalStartServices> {
    const selection = options.services === undefined ? {} : { services: options.services };
    const loaded = yield* installAndLoadGlobalPlan(selection);

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
    const verifyAdmission = yield* captureGlobalStartupAdmission();

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
        yield* verifyAdmission;
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
            beforeApply: verifyAdmission,
            ...(options.resolvedDebuggerHost === undefined
              ? {}
              : { resolvedDebuggerHost: options.resolvedDebuggerHost }),
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
        yield* recordGlobalRouterStartupPlan({
          services: Object.fromEntries(applied.services.map((service) => [service.name, service])),
        });
        const outcome = yield* completeStartup({
          policy: "global-groups",
          operation: "start",
          provider,
          router,
          outcome: applied,
          beforeRoutes: verifyAdmission,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        const planOrder = new Map(Object.keys(loaded.plan.services).map((id, index) => [id, index]));
        const servicesStarted = [
          ...startedServices(yield* collectObservedConnections(outcome.builtPlan, outcome.ready)),
        ].sort((left, right) => (planOrder.get(left.name) ?? 0) - (planOrder.get(right.name) ?? 0));
        return { app: loaded.plan.name, servicesStarted };
      }),
    );
  },
  (effect, _options: GlobalStartOptions = {}) => withGlobalMutation(effect),
);
