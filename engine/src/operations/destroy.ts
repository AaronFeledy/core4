import { rm } from "node:fs/promises";

import { DateTime, Effect, Schema } from "effect";

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
  LandofileService,
  PathsService,
  ProxyService,
  RuntimeProviderRegistry,
} from "@lando/sdk/services";

import { type ResolvedAppTarget, loadUserLandofile } from "../landofile/app-resolution.ts";
import { destroyAppAndRemoveRoutes } from "../lifecycle/routes.ts";

import { cleanupHostProxyRunLandoState } from "../subsystems/host-proxy/transport.ts";
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

    yield* events.publish(
      PreDestroyEvent.make({
        _tag: "pre-destroy",
        app: ref,
        timestamp: now(),
      }),
    );

    yield* terminateFileSyncSessions(ref);

    const providerDestroy = provider
      .destroy(
        { app: plan.id, plan },
        {
          volumes,
          ...(resolvedOptions.purgeCaches === undefined ? {} : { purgeCaches: resolvedOptions.purgeCaches }),
          removeState: true,
        },
      )
      .pipe(
        Effect.ensuring(cleanupHostProxyRunLandoState(ref, { ...paths.roots, platform: paths.platform })),
      );
    if (proxy._tag === "Some") {
      yield* destroyAppAndRemoveRoutes(providerDestroy, proxy.value, plan);
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
      yield* Effect.promise(() =>
        rm(paths.appSnapshotsDir(String(plan.id)), { recursive: true, force: true }).catch(() => undefined),
      );
    }

    yield* events.publish(
      PostDestroyEvent.make({
        _tag: "post-destroy",
        app: ref,
        timestamp: now(),
      }),
    );

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
        return yield* destroyAppForTarget(options, {
          plan,
          root: plan.root,
          app: appRef(plan),
          landofile,
        });
      })
    : destroyAppForTarget(options, target);
