import { DateTime, Effect, Schema } from "effect";

import type {
  RestartAppOptions,
  RestartAppResult,
  RestartAppError as SdkRestartAppError,
} from "@lando/sdk/app";
import type { ComposeKeyRejectedError, LandofileLoadExpressionError } from "@lando/sdk/errors";
import { PostRestartEvent, PreRestartEvent } from "@lando/sdk/events";
import { AppPlanner, EventService, LandofileService, RuntimeProviderRegistry } from "@lando/sdk/services";
import type {
  BuildOrchestrator,
  FileSystem,
  GlobalAppService,
  ManagedFileTransactionGuard,
  PathsService,
  PluginRegistry,
  ShellRunner,
} from "@lando/sdk/services";
import { RouterService } from "@lando/sdk/services";

import type { RedactionService } from "@lando/redaction/service";
import type { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { type ResolvedAppTarget, loadUserLandofile, userAppRef } from "../landofile/app-resolution.ts";
import { compensateFailureUnless } from "../lifecycle/failure-compensation.ts";
import { isPostStartStepError } from "../tooling/event-errors.ts";
import { runAppEvent, runAppInitEvents } from "./events.ts";
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
  | ManagedFileTransactionGuard
  | PathsService
  | PrivateFileAccessService
  | PluginRegistry
  | RouterService
  | RedactionService
  | RuntimeProviderRegistry
  | ShellRunner;

export const restartApp = (
  options: RestartAppOptions = {},
  target?: ResolvedAppTarget,
  managed?: StartManagedScope,
): Effect.Effect<RestartAppResult, RestartAppError, RestartAppServices> =>
  Effect.gen(function* () {
    const proxy = yield* RouterService;
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
    const events = yield* EventService;
    const preRestart = PreRestartEvent.make({
      _tag: "pre-restart",
      scope: "app",
      app: resolvedTarget.app,
      plan,
      triggeredBy: "app:restart",
      timestamp: DateTime.unsafeMake(new Date().toISOString()),
    });
    yield* events.publish(preRestart);
    yield* runAppEvent(plan, "pre-restart", preRestart);
    yield* stopAppWithPlan({}, resolvedTarget);
    yield* managed?.onStopped ?? Effect.void;
    const result = yield* compensateFailureUnless(
      startApp(
        {
          reconcile: options.reconcile ?? false,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        },
        resolvedTarget,
        managed,
      ),
      proxy.removeRoutes(plan.id),
      isPostStartStepError,
    );
    const postRestart = PostRestartEvent.make({
      _tag: "post-restart",
      scope: "app",
      app: resolvedTarget.app,
      plan,
      timestamp: DateTime.unsafeMake(new Date().toISOString()),
    });
    yield* events.publish(postRestart);
    yield* runAppEvent(plan, "post-restart", postRestart);
    return result;
  });
