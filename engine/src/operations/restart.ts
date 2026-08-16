import { Effect, Schema } from "effect";

import type {
  RestartAppOptions,
  RestartAppResult,
  RestartAppError as SdkRestartAppError,
} from "@lando/sdk/app";
import type { ComposeKeyRejectedError, LandofileLoadExpressionError } from "@lando/sdk/errors";
import { AppPlanner, LandofileService, RuntimeProviderRegistry } from "@lando/sdk/services";
import type {
  BuildOrchestrator,
  EventService,
  FileSystem,
  GlobalAppService,
  PathsService,
  PluginRegistry,
  ShellRunner,
} from "@lando/sdk/services";
import { ProxyService } from "@lando/sdk/services";

import type { RedactionService } from "@lando/redaction/service";
import { type ResolvedAppTarget, loadUserLandofile, userAppRef } from "../landofile/app-resolution.ts";
import { compensateFailure } from "../lifecycle/failure-compensation.ts";
import { runAppInitEvents } from "./events.ts";
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
    const resolvedTarget =
      target ??
      (yield* Effect.gen(function* () {
        const landofileService = yield* LandofileService;
        const registry = yield* RuntimeProviderRegistry;
        const planner = yield* AppPlanner;
        const landofile = yield* loadUserLandofile(landofileService);
        const capabilities = yield* registry.capabilities;
        const plan = yield* planner.plan(landofile, capabilities);
        return { plan, root: plan.root, app: userAppRef(plan), landofile } satisfies ResolvedAppTarget;
      }));
    const plan = resolvedTarget.plan;
    yield* runAppInitEvents(plan);
    yield* stopAppWithPlan({}, resolvedTarget);
    return yield* compensateFailure(
      startApp(
        {
          reconcile: options.reconcile ?? false,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        },
        resolvedTarget,
        managed,
      ),
      proxy.removeRoutes(plan.id),
    );
  });
