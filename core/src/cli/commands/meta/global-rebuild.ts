import { DateTime, Effect, Result, Schema } from "effect";

import { startedServiceRow } from "@lando/engine/operations/authority-url";
import { publishGlobalRoutes } from "@lando/engine/operations/global-routes";
import {
  applyGlobalServiceGroups,
  globalServiceGroupError,
} from "@lando/engine/operations/global-service-groups";
import type {
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
} from "@lando/sdk/errors";
import { PostGlobalRebuildEvent, PreGlobalRebuildEvent } from "@lando/sdk/events";
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
import { globalAppRef, renderGlobalServiceRow, withGlobalLifecycleEvents } from "./global-common";

import { globalInstall } from "@lando/engine/operations/global-install";
import { type LoadGlobalPlanError, loadGlobalPlan } from "@lando/engine/operations/global-plan";
import { MANAGED_PROVIDER_SELECT_PLAN } from "@lando/engine/providers/managed";

const now = () => DateTime.nowUnsafe();

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
  | GlobalAppError
  | LoadGlobalPlanError
  | BuildError
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
  | AppPlanner
  | BuildOrchestrator
  | EventService
  | FileSystem
  | GlobalAppService
  | PluginRegistry
  | RouterService
  | RuntimeProviderRegistry;

export const globalRebuild = Effect.fn("GlobalRebuild.rebuild")(function* (
  options: GlobalRebuildOptions = {},
): Effect.fn.Return<GlobalRebuildResult, GlobalRebuildError, GlobalRebuildServices> {
  yield* globalInstall({});
  const loaded = yield* loadGlobalPlan();
  if (!loaded.materialized) return { app: "global", materialized: false, servicesRebuilt: [] };

  const services = Object.values(loaded.plan.services);
  if (services.length === 0) return { app: loaded.plan.name, materialized: true, servicesRebuilt: [] };

  const registry = yield* RuntimeProviderRegistry;
  const provider = yield* registry.select(MANAGED_PROVIDER_SELECT_PLAN);
  const events = yield* EventService;
  const builder = yield* BuildOrchestrator;

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
      yield* provider.destroy(
        { app: loaded.plan.id, plan: loaded.plan },
        { volumes: false, removeState: false },
      );

      const outcome = yield* applyGlobalServiceGroups(
        loaded.plan,
        {
          provider,
          services,
          options: {
            reconcile: true,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
          },
        },
        (plan) => builder.build(plan, { pull: "always" }),
      );
      const partialError = globalServiceGroupError("rebuild", outcome);
      const router = yield* RouterService;
      const startedNames = new Set(outcome.services.map((service) => service.name));
      const failedNames = new Set(outcome.failures.flatMap((failure) => failure.names));
      const publish = publishGlobalRoutes(router, provider, outcome.builtPlan, {
        started: startedNames,
        failed: failedNames,
      });
      const publication = yield* Effect.result(publish);
      if (partialError !== undefined) {
        if (outcome.services.length > 0) yield* Effect.result(router.revalidateStartup);
        return yield* Effect.fail(partialError);
      }
      const { builtPlan } = outcome;
      if (Result.isFailure(publication)) {
        yield* Effect.result(router.revalidateStartup);
        return yield* Effect.fail(publication.failure);
      }
      const routeUrls = publication.success;
      const servicesRebuilt = yield* Effect.forEach(outcome.services, (service) =>
        provider.inspect({ app: builtPlan.id, service: service.name, plan: builtPlan }).pipe(
          Effect.map((runtime) => {
            const row = startedServiceRow(service, runtime);
            return { ...row, endpoints: [...row.endpoints, ...(routeUrls.get(service.name) ?? [])] };
          }),
        ),
      );

      // Re-observe the router before the post event: a rebuild that leaves the
      // router's startup observation broken has not finished rebuilding.
      yield* router.revalidateStartup;

      return { builtPlan, servicesRebuilt };
    }),
  );
  return { app: builtPlan.name, materialized: true, servicesRebuilt };
});

export const renderGlobalRebuildResult = (result: GlobalRebuildResult): string => {
  if (!result.materialized) return "global app is not installed";
  const services = joinServiceRows(result.servicesRebuilt.map(renderGlobalServiceRow));
  return lifecycleLine("rebuilt", result.app, services.length === 0 ? "no services" : services);
};
