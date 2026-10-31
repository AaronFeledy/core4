import { type GlobalMutationServices, withGlobalMutation } from "@lando/engine/global-app/mutation";
import {
  recordGlobalResourceCleanup,
  recordGlobalRouteCleanup,
} from "@lando/engine/global-app/reconciliation";
import { DateTime, Effect, Schema } from "effect";

import type { EventError, ProxyError } from "@lando/sdk/errors";

import { PostGlobalStopEvent, PreGlobalStopEvent } from "@lando/sdk/events";
import { StopAppOutcome, StopAppResult } from "@lando/sdk/schema";
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
  app: StopAppResult.fields.app,
  outcome: StopAppOutcome,
  materialized: Schema.Boolean.annotate({
    description: "Whether the global app has a materialized Landofile.",
  }),
  servicesStopped: StopAppResult.fields.servicesStopped,
});

export type GlobalStopResult = typeof GlobalStopResultSchema.Type;
export type GlobalStopOptions = { readonly services?: ReadonlyArray<string> };

export type GlobalStopError =
  | Effect.Error<ReturnType<typeof resolveGlobalTeardown>>
  | Effect.Error<ReturnType<typeof executeGlobalTeardown>>
  | Effect.Error<ReturnType<typeof resolveGlobalStopSelection>>
  | Effect.Error<ReturnType<typeof executeGlobalStopSelection>>
  | import("@lando/sdk/errors").GlobalAppError
  | EventError
  | ProxyError;

export type GlobalStopServices =
  | GlobalMutationServices
  | Effect.Services<ReturnType<typeof resolveGlobalTeardown>>
  | Effect.Services<ReturnType<typeof executeGlobalTeardown>>
  | Effect.Services<ReturnType<typeof resolveGlobalStopSelection>>
  | Effect.Services<ReturnType<typeof executeGlobalStopSelection>>
  | Effect.Services<ReturnType<typeof recordGlobalResourceCleanup>>
  | EventService
  | RouterService;

export const renderGlobalStopResult = (result: GlobalStopResult): string => {
  return teardownLine(result.outcome, result.app, result.servicesStopped);
};

export const globalStop = Effect.fn("GlobalStop.stop")(
  function* (
    options: GlobalStopOptions = {},
  ): Effect.fn.Return<GlobalStopResult, GlobalStopError, GlobalStopServices> {
    const loaded = yield* resolveGlobalTeardown();
    if (loaded.evidence.kind === "absent") {
      if (!options.services?.length) {
        const router = yield* RouterService;
        yield* router.removeRoutes(globalTeardownAppRef(loaded).id);
        yield* recordGlobalRouteCleanup();
      }
      return { app: "global", outcome: "unchanged", materialized: loaded.materialized, servicesStopped: [] };
    }
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
            ? yield* executeGlobalTeardown(loaded, { intent: "stop", volumes: false, removeState: false })
            : yield* executeGlobalStopSelection(loaded, selection);
        if (selection === undefined) {
          const router = yield* RouterService;
          yield* router.removeRoutes(app.id);
          yield* recordGlobalResourceCleanup();
        }
        return {
          app: "global",
          outcome: receipt.changed ? ("stopped" as const) : ("unchanged" as const),
          materialized: loaded.materialized,
          servicesStopped: receipt.services,
        };
      }),
    );
  },
  (effect, _options: GlobalStopOptions = {}) => withGlobalMutation(effect),
);
