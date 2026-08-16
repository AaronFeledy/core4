import { DateTime, Effect, Schema } from "effect";

import type {
  RebuildAppOptions,
  RebuildAppResult,
  RebuildAppError as SdkRebuildAppError,
} from "@lando/sdk/app";
import type { ComposeKeyRejectedError, LandofileLoadExpressionError } from "@lando/sdk/errors";
import type {
  BuildOrchestrator,
  FileSystem,
  GlobalAppService,
  PathsService,
  PluginRegistry,
  ShellRunner,
} from "@lando/sdk/services";
import {
  AppPlanner,
  EventService,
  LandofileService,
  ProxyService,
  RuntimeProviderRegistry,
} from "@lando/sdk/services";

import type { RedactionService } from "@lando/redaction/service";
import { PostRebuildEvent, PreRebuildEvent } from "@lando/sdk/events";
import type { AppRef } from "@lando/sdk/schema";
import { type ResolvedAppTarget, loadUserLandofile, userAppRef } from "../landofile/app-resolution.ts";
import { compensateFailure } from "../lifecycle/failure-compensation.ts";
import { runAppEvent, runAppInitEvents, runPostAppEvent } from "./events.ts";
import { type StartManagedScope, StartedServiceResultSchema, startApp } from "./start.ts";
import { stopAppWithPlan } from "./stop.ts";

export type RebuildAppError = SdkRebuildAppError | ComposeKeyRejectedError | LandofileLoadExpressionError;
export type { RebuildAppOptions, RebuildAppResult } from "@lando/sdk/app";

export const RebuildAppResultSchema = Schema.Struct({
  app: Schema.String,
  servicesRebuilt: Schema.Array(Schema.String),
  servicesStarted: Schema.Array(StartedServiceResultSchema),
});

type RebuildAppServices =
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

export const rebuildApp = (
  options: RebuildAppOptions = {},
  target?: ResolvedAppTarget,
  managed?: StartManagedScope,
): Effect.Effect<RebuildAppResult, RebuildAppError, RebuildAppServices> =>
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
    const events = yield* EventService;
    const ref: AppRef = resolvedTarget.app;
    const timestamp = () => DateTime.unsafeMake(new Date().toISOString());
    const preRebuild = PreRebuildEvent.make({ _tag: "pre-rebuild", app: ref, timestamp: timestamp() });
    yield* events.publish(preRebuild);
    yield* runAppEvent(plan, "pre-rebuild", preRebuild);
    yield* stopAppWithPlan({}, resolvedTarget);
    const start = yield* compensateFailure(
      startApp(
        {
          reconcile: true,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        },
        resolvedTarget,
        managed,
        { forceAppBuild: true },
      ),
      proxy.removeRoutes(plan.id),
    );
    const postRebuild = PostRebuildEvent.make({ _tag: "post-rebuild", app: ref, timestamp: timestamp() });
    yield* events.publish(postRebuild);
    yield* runPostAppEvent(plan, "post-rebuild", postRebuild);
    return {
      app: start.app,
      servicesRebuilt: start.servicesStarted.map((service) => service.name),
      servicesStarted: start.servicesStarted,
    };
  });
