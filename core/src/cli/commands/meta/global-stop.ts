import { DateTime, Effect, Schema } from "effect";

import type { EventError, ProxyError } from "@lando/sdk/errors";

import { PostGlobalStopEvent, PreGlobalStopEvent } from "@lando/sdk/events";
import { EventService, RouterService } from "@lando/sdk/services";
import { withGlobalLifecycleEvents } from "./global-common";

import {
  executeGlobalTeardown,
  globalTeardownAppRef,
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

export type GlobalStopError =
  | Effect.Error<ReturnType<typeof resolveGlobalTeardown>>
  | Effect.Error<ReturnType<typeof executeGlobalTeardown>>
  | EventError
  | ProxyError;

export type GlobalStopServices =
  | Effect.Services<ReturnType<typeof resolveGlobalTeardown>>
  | Effect.Services<ReturnType<typeof executeGlobalTeardown>>
  | EventService
  | RouterService;

export const renderGlobalStopResult = (result: GlobalStopResult): string => {
  return teardownLine(result.outcome, result.app, result.servicesStopped);
};

export const globalStop = Effect.fn("GlobalStop.stop")(function* (): Effect.fn.Return<
  GlobalStopResult,
  GlobalStopError,
  GlobalStopServices
> {
  const loaded = yield* resolveGlobalTeardown();
  if (loaded.evidence.kind === "absent")
    return { app: "global", outcome: "unchanged", materialized: loaded.materialized, servicesStopped: [] };
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
      const receipt = yield* executeGlobalTeardown(loaded, { volumes: false, removeState: false });
      const router = yield* RouterService;
      yield* router.removeRoutes(app.id);
      return {
        app: "global",
        outcome: receipt.changed ? ("stopped" as const) : ("unchanged" as const),
        materialized: loaded.materialized,
        servicesStopped: receipt.services,
      };
    }),
  );
});
