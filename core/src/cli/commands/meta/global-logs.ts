import { Effect } from "effect";

import type { LogsAppError } from "@lando/sdk/app";
import type { ComposeKeyRejectedError, LandofileLoadExpressionError } from "@lando/sdk/errors";
import type { RuntimeProviderRegistry } from "@lando/sdk/services";

import {
  type LoadGlobalPlanError,
  type LoadGlobalPlanServices,
  loadGlobalPlan,
} from "../../../operations/global-plan.ts";
import {
  type FollowLogsAppOptions,
  type LogsAppOptions,
  type LogsAppResult,
  followLogsForPlan,
  logsForPlan,
  validateSince,
} from "../../../operations/logs.ts";
import type { StreamFrameSink } from "../../../operations/stream-frame-sink.ts";

export { renderLogsAppResult as renderGlobalLogsResult } from "../logs.ts";
export type { LogsAppOptions as GlobalLogsOptions, FollowLogsAppOptions as FollowGlobalLogsOptions };

export type GlobalLogsResult = LogsAppResult;
export type GlobalLogsError =
  | ComposeKeyRejectedError
  | LogsAppError
  | LoadGlobalPlanError
  | LandofileLoadExpressionError;
export type GlobalLogsServices = LoadGlobalPlanServices | RuntimeProviderRegistry;

export const globalLogs = (
  options: LogsAppOptions = {},
): Effect.Effect<GlobalLogsResult, GlobalLogsError, GlobalLogsServices> =>
  Effect.gen(function* () {
    const loaded = yield* loadGlobalPlan();
    if (!loaded.materialized) {
      yield* validateSince(options.since);
      return { app: "global", lines: [] };
    }
    return yield* logsForPlan(loaded.plan, options);
  });

export const followGlobalLogs = (
  options: FollowLogsAppOptions = {},
): Effect.Effect<GlobalLogsResult, GlobalLogsError, GlobalLogsServices | StreamFrameSink> =>
  Effect.gen(function* () {
    const loaded = yield* loadGlobalPlan();
    if (!loaded.materialized) {
      yield* validateSince(options.since);
      return { app: "global", lines: [] };
    }
    return yield* followLogsForPlan(loaded.plan, options);
  });
