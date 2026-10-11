import { DateTime, Effect, Schema } from "effect";

import type { EventError, ProxyError } from "@lando/sdk/errors";

import { PostGlobalStopEvent, PreGlobalStopEvent } from "@lando/sdk/events";
import { EventService, RouterService } from "@lando/sdk/services";
import { withGlobalLifecycleEvents } from "./global-common";

import {
  executeGlobalStopSelection,
  executeGlobalTeardown,
  globalTeardownAppRef,
  resolveGlobalStopSelection,
  resolveGlobalTeardown,
} from "@lando/engine/operations/global-teardown";
import { teardownLine } from "../service-summary";

const now = () => DateTime.nowUnsafe();

export const GlobalStopResultSchema = Schema.Struct({
  app: Schema.String,
  outcome: Schema.Literals(["stopped", "unchanged"]),
  materialized: Schema.Boolean,
  servicesStopped: Schema.Array(Schema.String),
});

export type GlobalStopResult = typeof GlobalStopResultSchema.Type;
export type GlobalStopOptions = { readonly services?: ReadonlyArray<string> };

export type GlobalStopError =
  | Effect.Error<ReturnType<typeof resolveGlobalTeardown>>
  | Effect.Error<ReturnType<typeof executeGlobalTeardown>>
  | Effect.Error<ReturnType<typeof resolveGlobalStopSelection>>
  | Effect.Error<ReturnType<typeof executeGlobalStopSelection>>
  | EventError
  | ProxyError;

export type GlobalStopServices =
  | Effect.Services<ReturnType<typeof resolveGlobalTeardown>>
  | Effect.Services<ReturnType<typeof executeGlobalTeardown>>
  | Effect.Services<ReturnType<typeof resolveGlobalStopSelection>>
  | Effect.Services<ReturnType<typeof executeGlobalStopSelection>>
  | EventService
  | RouterService;

export const renderGlobalStopResult = (result: GlobalStopResult): string => {
  return teardownLine(result.outcome, result.app, result.servicesStopped);
};

export const globalStop = Effect.fn("GlobalStop.stop")(function* (
  options: GlobalStopOptions = {},
): Effect.fn.Return<GlobalStopResult, GlobalStopError, GlobalStopServices> {
  const loaded = yield* resolveGlobalTeardown();
  if (loaded.evidence.kind === "absent")
    return { app: "global", outcome: "unchanged", materialized: loaded.materialized, servicesStopped: [] };
  const selection = options.services?.length
    ? yield* resolveGlobalStopSelection(loaded, options.services)
    : undefined;
  if (selection?.services.length === 0) {
    yield* executeGlobalStopSelection(loaded, selection);
    return { app: "global", outcome: "unchanged", materialized: loaded.materialized, servicesStopped: [] };
  }
  const events = yield* EventService;
  const app = globalTeardownAppRef(loaded);

  return yield* withGlobalLifecycleEvents(
    {
      pre: () =>
        events.publish(
          PreGlobalStopEvent.make({
            scope: "global",
            app,
            triggeredBy: "meta:global:stop",
            timestamp: now(),
          }),
        ),
      post: () =>
        events.publish(
          PostGlobalStopEvent.make({
            scope: "global",
            app,
            timestamp: now(),
          }),
        ),
    },
    Effect.gen(function* () {
      const receipt =
        selection === undefined
          ? yield* executeGlobalTeardown(loaded, { volumes: false, removeState: false })
          : yield* executeGlobalStopSelection(loaded, selection);
      if (selection === undefined) {
        const router = yield* RouterService;
        yield* router.removeRoutes(app.id);
      }
      return {
        app: "global",
        outcome: receipt.changed ? ("stopped" as const) : ("unchanged" as const),
        materialized: loaded.materialized,
        servicesStopped: receipt.services,
      };
    }),
  );
});
