import {
  type LoadGlobalPlanServices,
  type LoadObservedGlobalPlanError,
  loadObservedGlobalPlan,
} from "@lando/engine/operations/global-plan";
import {
  type FollowLogsAppOptions,
  type LogsAppOptions,
  type LogsAppResult,
  followLogsForPlan,
  logsForPlan,
  validateSince,
} from "@lando/engine/operations/logs";
import type { StreamFrameSink } from "@lando/engine/operations/stream-frame-sink";
import type { LogsAppError } from "@lando/sdk/app";
import type { ComposeKeyRejectedError, LandofileLoadExpressionError } from "@lando/sdk/errors";
import type { RuntimeProviderRegistry } from "@lando/sdk/services";
import { Effect } from "effect";

export { renderLogsAppResult as renderGlobalLogsResult } from "../logs";
export type { FollowLogsAppOptions as FollowGlobalLogsOptions, LogsAppOptions as GlobalLogsOptions };

export type GlobalLogsResult = LogsAppResult;
export type GlobalLogsError =
  | ComposeKeyRejectedError
  | LogsAppError
  | LoadObservedGlobalPlanError
  | LandofileLoadExpressionError;
export type GlobalLogsServices = LoadGlobalPlanServices | RuntimeProviderRegistry;

export const globalLogs = Effect.fn("GlobalLogs.logs")(function* (
  options: LogsAppOptions = {},
): Effect.fn.Return<GlobalLogsResult, GlobalLogsError, GlobalLogsServices> {
  const loaded = yield* loadObservedGlobalPlan();
  if (!loaded.materialized) {
    yield* validateSince(options.since);
    return { app: "global", lines: [] };
  }
  return yield* logsForPlan(loaded.plan, options);
});

export const followGlobalLogs = Effect.fn("GlobalLogs.follow")(function* (
  options: FollowLogsAppOptions = {},
): Effect.fn.Return<GlobalLogsResult, GlobalLogsError, GlobalLogsServices | StreamFrameSink> {
  const loaded = yield* loadObservedGlobalPlan();
  if (!loaded.materialized) {
    yield* validateSince(options.since);
    return { app: "global", lines: [] };
  }
  return yield* followLogsForPlan(loaded.plan, options);
});
