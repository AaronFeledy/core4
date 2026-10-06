import { DateTime, Effect, Schema } from "effect";

import type { EventError, ProxyError } from "@lando/sdk/errors";

import { PostGlobalStopEvent, PreGlobalStopEvent } from "@lando/sdk/events";
import {
  type AppPlanner,
  EventService,
  type FileSystem,
  type GlobalAppService,
  type ProviderError,
  RouterService,
  RuntimeProviderRegistry,
} from "@lando/sdk/services";
import { globalAppRef, withGlobalLifecycleEvents } from "./global-common";

import { type LoadGlobalPlanError, loadGlobalPlan } from "@lando/engine/operations/global-plan";
import { MANAGED_PROVIDER_SELECT_PLAN } from "@lando/engine/providers/managed";
import { teardownLine } from "../service-summary";

const now = () => DateTime.nowUnsafe();

export interface GlobalStopResult {
  readonly app: string;
  readonly materialized: boolean;
  readonly servicesStopped: ReadonlyArray<string>;
}

export const GlobalStopResultSchema = Schema.Struct({
  app: Schema.String,
  materialized: Schema.Boolean,
  servicesStopped: Schema.Array(Schema.String),
});

export type GlobalStopError = LoadGlobalPlanError | EventError | ProviderError | ProxyError;

export type GlobalStopServices =
  | AppPlanner
  | EventService
  | FileSystem
  | GlobalAppService
  | RuntimeProviderRegistry
  | RouterService;

export const renderGlobalStopResult = (result: GlobalStopResult): string => {
  if (!result.materialized) return "Global app is not installed; nothing to stop.";
  return teardownLine("stopped", result.app, result.servicesStopped);
};

export const globalStop = Effect.fn("GlobalStop.stop")(function* (): Effect.fn.Return<
  GlobalStopResult,
  GlobalStopError,
  GlobalStopServices
> {
  const loaded = yield* loadGlobalPlan();
  if (!loaded.materialized) return { app: "global", materialized: false, servicesStopped: [] };

  const registry = yield* RuntimeProviderRegistry;
  const provider = yield* registry.select(MANAGED_PROVIDER_SELECT_PLAN);
  const events = yield* EventService;
  const servicesStopped = Object.values(loaded.plan.services)
    .reverse()
    .map((service) => String(service.name));

  return yield* withGlobalLifecycleEvents(
    {
      pre: () =>
        events.publish(
          PreGlobalStopEvent.make({
            scope: "global",
            app: globalAppRef(loaded.plan),
            triggeredBy: "meta:global:stop",
            timestamp: now(),
          }),
        ),
      post: () =>
        events.publish(
          PostGlobalStopEvent.make({
            scope: "global",
            app: globalAppRef(loaded.plan),
            timestamp: now(),
          }),
        ),
    },
    Effect.gen(function* () {
      yield* provider.destroy(
        { app: loaded.plan.id, plan: loaded.plan },
        { volumes: false, removeState: false },
      );
      const router = yield* RouterService;
      yield* router.removeRoutes(loaded.plan.id);
      return { app: loaded.plan.name, materialized: true, servicesStopped };
    }),
  );
});
