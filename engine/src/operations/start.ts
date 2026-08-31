import { DateTime, Effect, Ref, Schema } from "effect";

import type { StartAppError as SdkStartAppError, StartAppOptions, StartAppResult } from "@lando/sdk/app";
import {
  type ComposeKeyRejectedError,
  GlobalAutoStartError,
  type LandofileLoadExpressionError,
} from "@lando/sdk/errors";
import { PostAppStartEvent, PostStartEvent, PreAppStartEvent, PreStartEvent } from "@lando/sdk/events";
import { type AppPlan, type AppRef, ServiceName } from "@lando/sdk/schema";
import {
  AppPlanner,
  BuildOrchestrator,
  EventService,
  type FileSystem,
  type GlobalAppService,
  LandofileService,
  type PathsService,
  type PluginRegistry,
  RouterService,
  RuntimeProviderRegistry,
  type ShellRunner,
} from "@lando/sdk/services";

import type { RedactionService } from "@lando/redaction/service";
import { type ResolvedAppTarget, loadUserLandofile } from "../landofile/app-resolution.ts";
import {
  publishedTargetsFromEndpoints,
  rewriteCrossEngineProxyRoutes,
} from "../lifecycle/cross-engine-routes.ts";
import { compensateFailure } from "../lifecycle/failure-compensation.ts";
import { appliedProxyUrlsByService } from "../lifecycle/route-urls.ts";
import { applyAppRoutes, removeRoutesAndDestroyApp, teardownAppliedApp } from "../lifecycle/routes.ts";
import { taggedErrorRemediation } from "../providers/managed.ts";
import { withBuildProvider } from "../services/build-orchestrator.ts";
import { publishedEndpointUrl } from "./authority-url.ts";
import { ensureGlobalServicesRunning, requiredGlobalServicesForPlan } from "./ensure-global-services.ts";
import { runAppEvent, runAppInitEvents, runPostAppEvent } from "./events.ts";
import { type StartManagedScope, startFileSyncSessions } from "./start-file-sync.ts";
import { withStartedHostProxy } from "./start-host-proxy.ts";

import {
  withApplyProgress,
  withGlobalStartProgress,
  withRoutesStartProgress,
} from "./start-progress-phases.ts";

export type StartAppError = SdkStartAppError | ComposeKeyRejectedError | LandofileLoadExpressionError;
export type { StartAppOptions, StartAppResult } from "@lando/sdk/app";
export type { StartManagedScope } from "./start-file-sync.ts";
export const StartedServiceResultSchema = Schema.Struct({
  name: Schema.String,
  state: Schema.String,
  endpoints: Schema.Array(Schema.String),
});

export const StartAppResultSchema = Schema.Struct({
  app: Schema.String,
  servicesStarted: Schema.Array(StartedServiceResultSchema),
});

type StartAppServices =
  | AppPlanner
  | BuildOrchestrator
  | EventService
  | FileSystem
  | GlobalAppService
  | LandofileService
  | PathsService
  | PluginRegistry
  | RouterService
  | RedactionService
  | RuntimeProviderRegistry
  | ShellRunner;

type BoundStartAppServices = Exclude<StartAppServices, LandofileService>;

const now = () => DateTime.unsafeMake(new Date().toISOString());

const appRef = (plan: AppPlan): AppRef => ({ kind: "user", id: plan.id, root: plan.root });

export const startAppForTarget = (
  options: StartAppOptions | undefined,
  target: ResolvedAppTarget,
  managed?: StartManagedScope,
  execution: { readonly forceAppBuild?: boolean } = {},
): Effect.Effect<StartAppResult, SdkStartAppError, BoundStartAppServices> =>
  Effect.gen(function* () {
    const resolvedOptions = options ?? {};
    const registry = yield* RuntimeProviderRegistry;
    const events = yield* EventService;
    const builds = yield* BuildOrchestrator;
    const proxy = yield* RouterService;

    const plan = target.plan;
    const provider = yield* registry.select(plan);
    const ref = target.app;
    const applyStarted = yield* Ref.make(false);
    const routesApplied = yield* Ref.make(false);

    yield* events.publish(
      PreAppStartEvent.make({
        eventName: "pre-app-start",
        appRef: ref,
        providerId: plan.provider,
        timestamp: now(),
      }),
    );
    const preStart = PreStartEvent.make({
      _tag: "pre-start",
      scope: "app",
      app: ref,
      plan,
      triggeredBy: "app:start",
      timestamp: now(),
    });
    yield* events.publish(preStart);
    yield* runAppEvent(plan, "pre-start", preStart);

    const neededGlobalServices = requiredGlobalServicesForPlan(plan);
    if (neededGlobalServices.length > 0) {
      const ensureGlobals = ensureGlobalServicesRunning({
        services: neededGlobalServices,
        ...(resolvedOptions.signal === undefined ? {} : { signal: resolvedOptions.signal }),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new GlobalAutoStartError({
              message: `Failed to auto-start global services (${neededGlobalServices.join(", ")}) required by ${plan.name}.`,
              app: plan.name,
              services: [...neededGlobalServices],
              remediation:
                taggedErrorRemediation(cause) ??
                "Lando tried to install and start the required global services automatically. Fix the underlying error, then retry `lando start`.",
              cause,
            }),
        ),
      );
      yield* withGlobalStartProgress({ events, plan, serviceIds: neededGlobalServices, work: ensureGlobals });
    }

    return yield* withStartedHostProxy(plan, ref, provider.capabilities, {
      platform: provider.platform,
      ...(managed === undefined ? {} : { managed }),
      use: (applyPlan) =>
        Effect.gen(function* () {
          const builtPlan = yield* withBuildProvider(builds.build(applyPlan), provider);
          const serviceList = Object.values(builtPlan.services);

          const applyAndInspect = Effect.gen(function* () {
            yield* Ref.set(applyStarted, true);
            yield* Effect.scoped(
              provider.apply(builtPlan, {
                reconcile: resolvedOptions.reconcile ?? false,
                ...(resolvedOptions.signal === undefined ? {} : { signal: resolvedOptions.signal }),
              }),
            );
            return yield* Effect.forEach(serviceList, (service) =>
              provider.inspect({ app: plan.id, service: service.name }).pipe(
                Effect.map((runtime) => {
                  const sourceEndpoints = runtime.endpoints ?? service.endpoints;
                  return {
                    name: String(service.name),
                    state: runtime.state ?? runtime.status,
                    endpoints: sourceEndpoints.flatMap((endpoint) => {
                      if (endpoint._tag === "internal") return [];
                      const rendered = publishedEndpointUrl(endpoint);
                      return rendered === undefined ? [] : [rendered];
                    }),
                    published: publishedTargetsFromEndpoints(String(service.name), sourceEndpoints),
                  };
                }),
              ),
            );
          });
          const inspectedServices = yield* compensateFailure(
            withApplyProgress({ events, plan, services: serviceList, work: applyAndInspect }),
            teardownAppliedApp(provider, plan),
          );

          yield* compensateFailure(
            withBuildProvider(
              builds.buildApp(builtPlan, {
                ...(execution.forceAppBuild === true ? { force: true } : {}),
                ...(resolvedOptions.signal === undefined ? {} : { signal: resolvedOptions.signal }),
              }),
              provider,
            ),
            removeRoutesAndDestroyApp(proxy, provider, plan),
          );
          yield* startFileSyncSessions(plan, events, managed).pipe((effect) =>
            compensateFailure(effect, removeRoutesAndDestroyApp(proxy, provider, plan)),
          );

          const routedPlan = {
            ...builtPlan,
            routes: rewriteCrossEngineProxyRoutes({
              plan: builtPlan,
              published: inspectedServices.flatMap((service) => service.published),
            }),
          };
          const applyRoutes = applyAppRoutes(proxy, routedPlan, target.landofile?.router);
          const proxyResult = yield* compensateFailure(
            routedPlan.routes.length === 0
              ? applyRoutes
              : withRoutesStartProgress({ events, plan, work: applyRoutes }),
            removeRoutesAndDestroyApp(proxy, provider, plan),
          );
          yield* Ref.set(routesApplied, true);
          const proxyUrls = appliedProxyUrlsByService(proxyResult);
          const servicesStarted = inspectedServices.map((service) => ({
            ...service,
            endpoints: [...(proxyUrls.get(ServiceName.make(service.name)) ?? []), ...service.endpoints],
          }));

          yield* compensateFailure(
            events.publish(
              PostAppStartEvent.make({
                eventName: "post-app-start",
                appRef: ref,
                providerId: plan.provider,
                timestamp: now(),
              }),
            ),
            removeRoutesAndDestroyApp(proxy, provider, plan),
          );
          const postStart = PostStartEvent.make({
            _tag: "post-start",
            scope: "app",
            app: ref,
            plan,
            timestamp: now(),
          });
          yield* events.publish(postStart);
          yield* runPostAppEvent(plan, "post-start", postStart);

          return { app: plan.name, servicesStarted };
        }),
    }).pipe(
      Effect.onInterrupt(() =>
        Effect.all([Ref.get(applyStarted), Ref.get(routesApplied)]).pipe(
          Effect.flatMap(([started, routed]) => {
            if (routed) return removeRoutesAndDestroyApp(proxy, provider, plan);
            return started ? removeRoutesAndDestroyApp(proxy, provider, plan) : Effect.void;
          }),
          Effect.orDie,
        ),
      ),
    );
  });

export const startApp = (
  options: StartAppOptions = {},
  target?: ResolvedAppTarget,
  managed?: StartManagedScope,
  execution: { readonly forceAppBuild?: boolean } = {},
): Effect.Effect<StartAppResult, StartAppError, StartAppServices> =>
  target === undefined
    ? Effect.gen(function* () {
        const landofileService = yield* LandofileService;
        const registry = yield* RuntimeProviderRegistry;
        const planner = yield* AppPlanner;
        const landofile = yield* loadUserLandofile(landofileService);
        const capabilities = yield* registry.capabilities;
        const plan = yield* planner.plan(landofile, capabilities);
        yield* runAppInitEvents(plan);
        return yield* startAppForTarget(
          options,
          { plan, root: plan.root, app: appRef(plan), landofile },
          managed,
          execution,
        );
      })
    : startAppForTarget(options, target, managed, execution);
