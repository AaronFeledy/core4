import { rm } from "node:fs/promises";

import { DateTime, Effect, Option, Schema } from "effect";

import type {
  DestroyAppOptions,
  DestroyAppResult,
  DestroyAppError as SdkDestroyAppError,
} from "@lando/sdk/app";
import type { ComposeKeyRejectedError, LandofileLoadExpressionError } from "@lando/sdk/errors";
import { MessageWarnEvent, PostDestroyEvent, PreDestroyEvent } from "@lando/sdk/events";
import type { AppPlan, AppRef } from "@lando/sdk/schema";
import {
  AppPlanner,
  EventService,
  FileSyncEngine,
  LandofileService,
  PathsService,
  ProxyService,
  RuntimeProviderRegistry,
} from "@lando/sdk/services";

import { type ResolvedAppTarget, loadUserLandofile } from "../landofile/app-resolution.ts";
import { runAllAndMergeFailures } from "../lifecycle/failure-compensation.ts";

import { cleanupHostProxyRunLandoState } from "../subsystems/host-proxy/transport.ts";
import { withDestroyProgress } from "./destroy-progress.ts";
import { runAppEvent, runAppInitEvents, runPostAppEvent } from "./events.ts";
import { terminateFileSyncSessions } from "./file-sync.ts";

export type DestroyAppError = SdkDestroyAppError | ComposeKeyRejectedError | LandofileLoadExpressionError;
export type { DestroyAppOptions, DestroyAppResult } from "@lando/sdk/app";

export const DestroyAppResultSchema = Schema.Struct({
  app: Schema.String,
  servicesDestroyed: Schema.Array(Schema.String),
  volumesRemoved: Schema.Boolean,
});

type DestroyAppServices =
  | AppPlanner
  | EventService
  | LandofileService
  | PathsService
  | RuntimeProviderRegistry;
type BoundDestroyAppServices = Exclude<DestroyAppServices, AppPlanner | LandofileService>;

const now = () => DateTime.unsafeMake(new Date().toISOString());

const appRef = (plan: AppPlan): AppRef => ({ kind: "user", id: plan.id, root: plan.root });

export const destroyAppForTarget = (
  options: DestroyAppOptions | undefined,
  target: ResolvedAppTarget,
): Effect.Effect<DestroyAppResult, SdkDestroyAppError, BoundDestroyAppServices> =>
  Effect.gen(function* () {
    const resolvedOptions = options ?? {};
    const registry = yield* RuntimeProviderRegistry;
    const events = yield* EventService;
    const paths = yield* PathsService;
    const proxy = yield* Effect.serviceOption(ProxyService);

    const plan = target.plan;
    const provider = yield* registry.select(plan);
    const ref = target.app;
    const volumes = resolvedOptions.volumes ?? false;

    const preDestroy = PreDestroyEvent.make({
      _tag: "pre-destroy",
      app: ref,
      timestamp: now(),
    });
    yield* events.publish(preDestroy);
    yield* runAppEvent(plan, "pre-destroy", preDestroy);

    const fileSync = yield* Effect.serviceOption(FileSyncEngine);
    const fileSyncApplicable = yield* Option.match(fileSync, {
      onNone: () => Effect.succeed(false),
      onSome: (engine) => engine.isAvailable,
    });

    yield* withDestroyProgress({
      events,
      plan,
      children: {
        fileSync: fileSyncApplicable,
        proxy: proxy._tag === "Some",
        snapshots: volumes,
      },
      work: (tree) =>
        Effect.gen(function* () {
          if (fileSyncApplicable) yield* tree.startTask("file-sync");
          yield* terminateFileSyncSessions(ref);
          if (fileSyncApplicable) yield* tree.completeTask("file-sync");

          yield* tree.startTask("provider");
          const providerDestroy = provider
            .destroy(
              { app: plan.id, plan },
              {
                volumes,
                ...(resolvedOptions.purgeCaches === undefined
                  ? {}
                  : { purgeCaches: resolvedOptions.purgeCaches }),
                removeState: true,
              },
            )
            .pipe(
              Effect.ensuring(
                Effect.gen(function* () {
                  yield* tree.startTask("host-proxy");
                  yield* cleanupHostProxyRunLandoState(ref, { ...paths.roots, platform: paths.platform });
                  yield* tree.completeTask("host-proxy");
                }),
              ),
              Effect.tap(() => tree.completeTask("provider")),
              Effect.tapError(() => tree.failTask("provider")),
            );
          if (proxy._tag === "Some") {
            const removeRoutes = tree.startTask("routes").pipe(
              Effect.zipRight(proxy.value.removeRoutes(plan.id)),
              Effect.tap(() => tree.completeTask("routes")),
              Effect.tapError(() => tree.failTask("routes")),
            );
            yield* runAllAndMergeFailures<SdkDestroyAppError, never>([providerDestroy, removeRoutes]);
          } else {
            yield* events.publish(
              MessageWarnEvent.make({
                body: `Proxy service is unavailable; destroying ${plan.name} without route cleanup.`,
                timestamp: now(),
              }),
            );
            yield* providerDestroy;
          }

          if (volumes) {
            yield* tree.startTask("snapshots");
            yield* Effect.promise(() =>
              rm(paths.appSnapshotsDir(String(plan.id)), { recursive: true, force: true }).catch(
                () => undefined,
              ),
            );
            yield* tree.completeTask("snapshots");
          }
        }),
    });

    const postDestroy = PostDestroyEvent.make({
      _tag: "post-destroy",
      app: ref,
      timestamp: now(),
    });
    yield* events.publish(postDestroy);
    yield* runPostAppEvent(plan, "post-destroy", postDestroy);

    return {
      app: plan.name,
      servicesDestroyed: Object.values(plan.services)
        .reverse()
        .map((service) => String(service.name)),
      volumesRemoved: volumes || resolvedOptions.purgeCaches === true,
    };
  });

export const destroyApp = (
  options: DestroyAppOptions = {},
  target?: ResolvedAppTarget,
): Effect.Effect<DestroyAppResult, DestroyAppError, DestroyAppServices> =>
  target === undefined
    ? Effect.gen(function* () {
        const landofileService = yield* LandofileService;
        const registry = yield* RuntimeProviderRegistry;
        const planner = yield* AppPlanner;
        const landofile = yield* loadUserLandofile(landofileService);
        const capabilities = yield* registry.capabilities;
        const plan = yield* planner.plan(landofile, capabilities);
        yield* runAppInitEvents(plan);
        return yield* destroyAppForTarget(options, {
          plan,
          root: plan.root,
          app: appRef(plan),
          landofile,
        });
      })
    : destroyAppForTarget(options, target);
