/**
 * `lando restart` — `stop` + `start`.
 *
 * Bootstrap level: `app`.
 */
import { Effect, Schema } from "effect";

import type {
  RestartAppOptions,
  RestartAppResult,
  RestartAppError as SdkRestartAppError,
} from "@lando/sdk/app";
import type { ComposeKeyRejectedError, LandofileLoadExpressionError } from "@lando/sdk/errors";
import type {
  AppPlanner,
  BuildOrchestrator,
  EventService,
  FileSystem,
  GlobalAppService,
  LandofileService,
  PathsService,
  PluginRegistry,
  RuntimeProviderRegistry,
  ShellRunner,
} from "@lando/sdk/services";
import { ProxyService } from "@lando/sdk/services";

import type { ResolvedAppTarget } from "../landofile/app-resolution.ts";
import { compensateFailure } from "../lifecycle/failure-compensation.ts";
import type { RedactionService } from "../redaction/service.ts";
import { type StartManagedScope, StartedServiceResultSchema, startApp } from "./start.ts";
import { stopAppWithPlan } from "./stop.ts";

export type RestartAppError = SdkRestartAppError | ComposeKeyRejectedError | LandofileLoadExpressionError;
export type { RestartAppOptions, RestartAppResult } from "@lando/sdk/app";

export const RestartAppResultSchema = Schema.Struct({
  app: Schema.String,
  servicesStarted: Schema.Array(StartedServiceResultSchema),
});

type RestartAppServices =
  | AppPlanner
  | BuildOrchestrator
  | EventService
  | FileSystem
  | GlobalAppService
  | LandofileService
  | PathsService
  | PluginRegistry
  | ProxyService
  | RedactionService
  | RuntimeProviderRegistry
  | ShellRunner;

export const restartApp = (
  options: RestartAppOptions = {},
  target?: ResolvedAppTarget,
  managed?: StartManagedScope,
): Effect.Effect<RestartAppResult, RestartAppError, RestartAppServices> =>
  Effect.gen(function* () {
    const proxy = yield* ProxyService;
    const { plan } = yield* stopAppWithPlan({}, target);
    return yield* compensateFailure(
      startApp(
        {
          reconcile: options.reconcile ?? false,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        },
        target,
        managed,
      ),
      proxy.removeRoutes(plan.id),
    );
  });
