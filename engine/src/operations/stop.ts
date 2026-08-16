import { DateTime, Effect, Schema } from "effect";

import type { StopAppError as SdkStopAppError, StopAppOptions, StopAppResult } from "@lando/sdk/app";
import type { ComposeKeyRejectedError, LandofileLoadExpressionError } from "@lando/sdk/errors";
import {
  PostAppStopEvent,
  PostServiceStopEvent,
  PostStopEvent,
  PreAppStopEvent,
  PreServiceStopEvent,
  PreStopEvent,
} from "@lando/sdk/events";
import type { AppPlan, AppRef } from "@lando/sdk/schema";
import {
  AppPlanner,
  EventService,
  LandofileService,
  PathsService,
  RuntimeProviderRegistry,
} from "@lando/sdk/services";

import { type ResolvedAppTarget, loadUserLandofile } from "../landofile/app-resolution.ts";

import { cleanupHostProxyRunLandoState } from "../subsystems/host-proxy/transport.ts";
import { runAppEvent, runAppInitEvents, runPostAppEvent } from "./events.ts";
import { terminateFileSyncSessions } from "./file-sync.ts";

export type StopAppError = SdkStopAppError | ComposeKeyRejectedError | LandofileLoadExpressionError;
export type { StopAppOptions, StopAppResult } from "@lando/sdk/app";

export const StopAppResultSchema = Schema.Struct({
  app: Schema.String,
  servicesStopped: Schema.Array(Schema.String),
});

type StopAppServices = AppPlanner | EventService | LandofileService | PathsService | RuntimeProviderRegistry;
type BoundStopAppServices = Exclude<StopAppServices, AppPlanner | LandofileService>;

const now = () => DateTime.unsafeMake(new Date().toISOString());

const appRef = (plan: AppPlan): AppRef => ({ kind: "user", id: plan.id, root: plan.root });

const stopAppWithResolvedPlan = (
  _options: StopAppOptions | undefined,
  target: ResolvedAppTarget,
): Effect.Effect<
  { readonly result: StopAppResult; readonly plan: AppPlan },
  SdkStopAppError,
  BoundStopAppServices
> =>
  Effect.gen(function* () {
    const registry = yield* RuntimeProviderRegistry;
    const events = yield* EventService;
    const paths = yield* PathsService;

    const plan = target.plan;
    const provider = yield* registry.select(plan);
    const ref = target.app;

    yield* events.publish(
      PreAppStopEvent.make({
        eventName: "pre-app-stop",
        appRef: ref,
        providerId: plan.provider,
        timestamp: now(),
      }),
    );
    const preStop = PreStopEvent.make({ _tag: "pre-stop", scope: "app", app: ref, timestamp: now() });
    yield* events.publish(preStop);
    yield* runAppEvent(plan, "pre-stop", preStop);

    const services = Object.values(plan.services).reverse();
    for (const service of services) {
      yield* events.publish(
        PreServiceStopEvent.make({
          eventName: "pre-service-stop",
          appRef: ref,
          serviceName: service.name,
          providerId: plan.provider,
          timestamp: now(),
        }),
      );
    }

    yield* terminateFileSyncSessions(ref);

    yield* provider
      .destroy({ app: plan.id, plan }, { volumes: false, removeState: false })
      .pipe(
        Effect.ensuring(cleanupHostProxyRunLandoState(ref, { ...paths.roots, platform: paths.platform })),
      );

    for (const service of services) {
      yield* events.publish(
        PostServiceStopEvent.make({
          eventName: "post-service-stop",
          appRef: ref,
          serviceName: service.name,
          providerId: plan.provider,
          timestamp: now(),
        }),
      );
    }

    yield* events.publish(
      PostAppStopEvent.make({
        eventName: "post-app-stop",
        appRef: ref,
        providerId: plan.provider,
        timestamp: now(),
      }),
    );
    const postStop = PostStopEvent.make({ _tag: "post-stop", scope: "app", app: ref, timestamp: now() });
    yield* events.publish(postStop);
    yield* runPostAppEvent(plan, "post-stop", postStop);

    return {
      result: { app: plan.name, servicesStopped: services.map((service) => String(service.name)) },
      plan,
    };
  });

export const stopAppWithPlan = (
  options: StopAppOptions = {},
  target?: ResolvedAppTarget,
): Effect.Effect<
  { readonly result: StopAppResult; readonly plan: AppPlan },
  StopAppError,
  StopAppServices
> =>
  target === undefined
    ? Effect.gen(function* () {
        const landofileService = yield* LandofileService;
        const registry = yield* RuntimeProviderRegistry;
        const planner = yield* AppPlanner;
        const landofile = yield* loadUserLandofile(landofileService);
        const capabilities = yield* registry.capabilities;
        const plan = yield* planner.plan(landofile, capabilities);
        yield* runAppInitEvents(plan);
        return yield* stopAppWithResolvedPlan(options, {
          plan,
          root: plan.root,
          app: appRef(plan),
          landofile,
        });
      })
    : stopAppWithResolvedPlan(options, target);

export const stopAppForTarget = (
  options: StopAppOptions | undefined,
  target: ResolvedAppTarget,
): Effect.Effect<StopAppResult, SdkStopAppError, BoundStopAppServices> =>
  stopAppWithResolvedPlan(options, target).pipe(Effect.map(({ result }) => result));

export const stopApp = (
  options: StopAppOptions = {},
  target?: ResolvedAppTarget,
): Effect.Effect<StopAppResult, StopAppError, StopAppServices> =>
  stopAppWithPlan(options, target).pipe(Effect.map(({ result }) => result));
