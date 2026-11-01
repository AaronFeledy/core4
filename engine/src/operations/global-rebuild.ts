import { type GlobalMutationServices, withGlobalMutation } from "@lando/engine/global-app/mutation";
import { revalidateAppliedGlobalRouterStartup } from "@lando/engine/global-app/router-admission";
import { captureGlobalStartupAdmission } from "@lando/engine/global-app/startup-admission";
import { DateTime, Effect, Schema } from "effect";

import { completeStartup } from "@lando/engine/lifecycle/startup-completion";
import { collectObservedConnections, startedServices } from "@lando/engine/operations/connection-collector";
import { applyGlobalServiceGroups } from "@lando/engine/operations/global-service-groups";
import { resolveDebuggerHost } from "@lando/engine/subsystems/debugger-host";
import type {
  DebuggerHostUnavailableError,
  GlobalAppError,
  GlobalDistConflictError,
  GlobalLandofilePathConflictError,
  GlobalServiceCollisionError,
  PluginManifestError,
  ProxyApplyError,
  ProxyError,
  RouterWatcherError,
  SecretNotFoundError,
  SecretReferenceInvalidError,
  SecretStoreUnavailableError,
  ServiceNotReadyError,
} from "@lando/sdk/errors";
import { PostGlobalRebuildEvent, PreGlobalRebuildEvent } from "@lando/sdk/events";
import { StartedService } from "@lando/sdk/schema";
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
import { globalAppRef, withGlobalLifecycleEvents } from "./global-common";

import { installAndLoadGlobalPlan } from "@lando/engine/operations/global-install";
import type { LoadGlobalPlanError } from "@lando/engine/operations/global-plan";

const now = () => DateTime.nowUnsafe();

export interface GlobalRebuildOptions {
  readonly signal?: AbortSignal;
}

export const GlobalRebuildResultSchema = Schema.Struct({
  app: Schema.String,
  materialized: Schema.Boolean,
  servicesRebuilt: Schema.Array(StartedService),
});
export type GlobalRebuildResult = typeof GlobalRebuildResultSchema.Type;

export type GlobalRebuildError =
  | Effect.Error<ReturnType<typeof installAndLoadGlobalPlan>>
  | ServiceNotReadyError
  | GlobalAppError
  | LoadGlobalPlanError
  | BuildError
  | DebuggerHostUnavailableError
  | GlobalDistConflictError
  | GlobalLandofilePathConflictError
  | GlobalServiceCollisionError
  | PluginManifestError
  | ProxyApplyError
  | ProviderError
  | ProxyError
  | RouterWatcherError
  | SecretNotFoundError
  | SecretStoreUnavailableError
  | SecretReferenceInvalidError;

export type GlobalRebuildServices =
  | GlobalMutationServices
  | import("@lando/sdk/services").StateStore
  | import("@lando/sdk/services").EnvironmentValueResolver
  | AppPlanner
  | BuildOrchestrator
  | EventService
  | FileSystem
  | GlobalAppService
  | PluginRegistry
  | RouterService
  | RuntimeProviderRegistry;

export const globalRebuild = Effect.fn("GlobalRebuild.rebuild")(
  function* (
    options: GlobalRebuildOptions = {},
  ): Effect.fn.Return<GlobalRebuildResult, GlobalRebuildError, GlobalRebuildServices> {
    const loaded = yield* installAndLoadGlobalPlan();

    const services = Object.values(loaded.plan.services);
    if (services.length === 0) {
      yield* revalidateAppliedGlobalRouterStartup(loaded.plan);
      return { app: loaded.plan.name, materialized: true, servicesRebuilt: [] };
    }
    const debuggerHost = yield* resolveDebuggerHost(loaded.plan);

    const registry = yield* RuntimeProviderRegistry;
    const provider = yield* registry.select(loaded.plan.provider);
    const events = yield* EventService;
    const builder = yield* BuildOrchestrator;
    const verifyAdmission = yield* captureGlobalStartupAdmission();

    const { builtPlan, servicesRebuilt } = yield* withGlobalLifecycleEvents(
      {
        pre: () =>
          events.publish(
            PreGlobalRebuildEvent.make({
              scope: "global",
              app: globalAppRef(loaded.plan),
              plan: loaded.plan,
              timestamp: now(),
            }),
          ),
        post: ({ builtPlan, servicesRebuilt }) =>
          events.publish(
            PostGlobalRebuildEvent.make({
              scope: "global",
              app: globalAppRef(builtPlan),
              plan: builtPlan,
              services: servicesRebuilt.map((service) => service.name),
              timestamp: now(),
            }),
          ),
      },
      Effect.gen(function* () {
        yield* verifyAdmission;
        yield* provider.destroy(
          { app: loaded.plan.id, plan: loaded.plan },
          { volumes: false, removeState: false },
        );

        const applied = yield* applyGlobalServiceGroups(
          loaded.plan,
          {
            provider,
            services,
            beforeApply: verifyAdmission,
            resolvedDebuggerHost: { address: debuggerHost },
            options: {
              reconcile: true,
              ...(options.signal === undefined ? {} : { signal: options.signal }),
            },
          },
          (plan) => builder.build(plan, { refresh: true }),
        );
        const router = yield* RouterService;
        const revalidateRouter = revalidateAppliedGlobalRouterStartup({
          services: Object.fromEntries(applied.services.map((service) => [service.name, service])),
        });
        const outcome = yield* completeStartup({
          policy: "global-groups",
          operation: "rebuild",
          provider,
          router,
          outcome: applied,
          beforeRoutes: verifyAdmission,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        }).pipe(Effect.tapError(() => Effect.asVoid(Effect.result(revalidateRouter))));
        const { builtPlan } = outcome;
        // Re-observe the router before the post event: a rebuild that leaves the
        // router's startup observation broken has not finished rebuilding.
        yield* revalidateRouter;
        const servicesRebuilt = startedServices(yield* collectObservedConnections(builtPlan, outcome.ready));

        return { builtPlan, servicesRebuilt };
      }),
    );
    return { app: builtPlan.name, materialized: true, servicesRebuilt };
  },
  (effect, _options: GlobalRebuildOptions = {}) => withGlobalMutation(effect),
);
