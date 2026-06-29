import { DateTime, Effect, Schema } from "effect";

import type {
  CapabilityError,
  EventError,
  GlobalAppError,
  LandofileParseError,
  LandofileValidationError,
  NoProviderInstalledError,
  NotImplementedError,
  ProviderConfigError,
  ProviderUnavailableError,
} from "@lando/sdk/errors";
import { PostGlobalStopEvent, PreGlobalStopEvent } from "@lando/sdk/events";
import type { AppPlan, AppRef } from "@lando/sdk/schema";
import {
  type AppPlanner,
  EventService,
  type FileSystem,
  type FileSystemError,
  type GlobalAppService,
  type ProviderError,
  RuntimeProviderRegistry,
} from "@lando/sdk/services";

import { loadGlobalPlan } from "./global-plan.ts";

const now = () => DateTime.unsafeMake(new Date().toISOString());

const globalAppRef = (plan: AppPlan): AppRef => ({ kind: "global", id: plan.id, root: plan.root });

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

type GlobalStopError =
  | CapabilityError
  | EventError
  | FileSystemError
  | GlobalAppError
  | LandofileParseError
  | LandofileValidationError
  | NoProviderInstalledError
  | NotImplementedError
  | ProviderConfigError
  | ProviderError
  | ProviderUnavailableError;

type GlobalStopServices = AppPlanner | EventService | FileSystem | GlobalAppService | RuntimeProviderRegistry;

export const renderGlobalStopResult = (result: GlobalStopResult): string => {
  if (!result.materialized) return "Global app is not installed; nothing to stop.";
  const services = result.servicesStopped.length === 0 ? "no services" : result.servicesStopped.join(", ");
  return `stopped: ${result.app} - ${services}`;
};

export const globalStop = (): Effect.Effect<GlobalStopResult, GlobalStopError, GlobalStopServices> =>
  Effect.gen(function* () {
    const loaded = yield* loadGlobalPlan();
    if (!loaded.materialized) return { app: "global", materialized: false, servicesStopped: [] };

    const registry = yield* RuntimeProviderRegistry;
    const provider = yield* registry.select(loaded.plan);
    const events = yield* EventService;
    const servicesStopped = Object.values(loaded.plan.services)
      .reverse()
      .map((service) => String(service.name));

    yield* events.publish(
      PreGlobalStopEvent.make({
        scope: "global",
        app: globalAppRef(loaded.plan),
        triggeredBy: "meta:global:stop",
        timestamp: now(),
      }),
    );

    yield* provider.destroy(
      { app: loaded.plan.id, plan: loaded.plan },
      { volumes: false, removeState: false },
    );

    yield* events.publish(
      PostGlobalStopEvent.make({
        scope: "global",
        app: globalAppRef(loaded.plan),
        timestamp: now(),
      }),
    );

    return { app: loaded.plan.name, materialized: true, servicesStopped };
  });
