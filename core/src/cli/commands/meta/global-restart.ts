import { type GlobalMutationServices, withGlobalMutation } from "@lando/engine/global-app/mutation";
import { Effect, Ref } from "effect";

import type { ProxyError, RouterWatcherError } from "@lando/sdk/errors";
import type { RouterService } from "@lando/sdk/services";

import {
  type GlobalRouterStartupPlan,
  revalidateAppliedGlobalRouterStartup,
  withGlobalRouterStartupPlanObserver,
} from "@lando/engine/global-app/router-admission";

import { globalCreateProviderId } from "@lando/engine/global-app/placement";
import { lifecycleLine, serviceRowsText } from "../service-summary";

import {
  type GlobalStartError,
  type GlobalStartResult,
  GlobalStartResultSchema,
  type GlobalStartServices,
  globalStart,
} from "./global-start";
import { type GlobalStopError, type GlobalStopServices, globalStop } from "./global-stop";

export interface GlobalRestartOptions {
  readonly signal?: AbortSignal;
}

export type GlobalRestartResult = GlobalStartResult;
export const GlobalRestartResultSchema = GlobalStartResultSchema;

export type GlobalRestartError = GlobalStartError | GlobalStopError | ProxyError | RouterWatcherError;
export type GlobalRestartServices =
  | GlobalMutationServices
  | GlobalStartServices
  | GlobalStopServices
  | RouterService;

export const renderGlobalRestartResult = (result: GlobalRestartResult): string => {
  return lifecycleLine("restarted", result.app, serviceRowsText(result.servicesStarted));
};

export const globalRestart = Effect.fn("GlobalRestart.restart")(
  function* (
    options: GlobalRestartOptions = {},
  ): Effect.fn.Return<GlobalRestartResult, GlobalRestartError, GlobalRestartServices> {
    // A placement mismatch would only surface in the start phase; refuse before stopping the router.
    yield* globalCreateProviderId();
    yield* globalStop();
    const appliedPlan = yield* Ref.make<GlobalRouterStartupPlan | undefined>(undefined);
    const revalidateRouter = Effect.flatMap(Ref.get(appliedPlan), revalidateAppliedGlobalRouterStartup);
    const result = yield* globalStart(options.signal === undefined ? {} : { signal: options.signal }).pipe(
      (effect) => withGlobalRouterStartupPlanObserver(effect, (plan) => Ref.set(appliedPlan, plan)),
      Effect.catchTags({
        GlobalAppError: Effect.fnUntraced(function* (error) {
          if (error.operation === "start") {
            yield* Effect.result(revalidateRouter);
          }
          return yield* Effect.fail(error);
        }),
        ProxyApplyError: Effect.fnUntraced(function* (error) {
          yield* Effect.result(revalidateRouter);
          return yield* Effect.fail(error);
        }),
        ServiceNotReadyError: Effect.fnUntraced(function* (error) {
          yield* Effect.result(revalidateRouter);
          return yield* Effect.fail(error);
        }),
      }),
    );
    // The router is the reason this command is prescribed as a recovery step,
    // so re-observe its startup here: without it a restart cannot affect the
    // persisted observation doctor keeps reporting.
    yield* revalidateRouter;
    return result;
  },
  (effect, _options: GlobalRestartOptions = {}) => withGlobalMutation(effect),
);
