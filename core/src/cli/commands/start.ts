/**
 * `lando start` — start the current app.
 *
 * Bootstrap level: `app`.
 *
 * Programmatic equivalent: `startApp({ reconcile: false })` from
 * `@lando/core/cli`.
 */
import { DateTime, Effect, Ref } from "effect";

import type { StartAppError, StartAppOptions, StartAppResult } from "@lando/sdk/app";
import { GlobalAutoStartError } from "@lando/sdk/errors";
import { PostAppStartEvent, PreAppStartEvent } from "@lando/sdk/events";
import { type AppPlan, type AppRef, type PublishedEndpoint, ServiceName } from "@lando/sdk/schema";
import {
  AppPlanner,
  BuildOrchestrator,
  EventService,
  type FileSystem,
  type GlobalAppService,
  LandofileService,
  type PathsService,
  type PluginRegistry,
  ProxyService,
  RuntimeProviderRegistry,
  type ShellRunner,
} from "@lando/sdk/services";

import { compensateFailure } from "../../lifecycle/failure-compensation.ts";
import { appliedProxyUrlsByService } from "../../lifecycle/route-urls.ts";
import { applyAppRoutes, removeRoutesAndDestroyApp, teardownAppliedApp } from "../../lifecycle/routes.ts";
import type { RedactionService } from "../../redaction/service.ts";
import { withBuildProvider } from "../../services/build-orchestrator.ts";
import { type ResolvedAppTarget, loadUserLandofile } from "../app-resolution.ts";
import { type MaterializedPublishedEndpoint, publishedEndpointUrl } from "../authority-url.ts";
import { ensureGlobalServicesRunning, requiredGlobalServicesForPlan } from "./meta/ensure-global-services.ts";
import { type StartManagedScope, startFileSyncSessions } from "./start-file-sync.ts";
import { withStartedHostProxy } from "./start-host-proxy.ts";

import {
  publishTaskComplete,
  publishTaskFail,
  publishTaskStart,
  publishTreeComplete,
  publishTreeStart,
} from "../progress.ts";

export type { StartAppError, StartAppOptions, StartAppResult } from "@lando/sdk/app";
export type { StartManagedScope } from "./start-file-sync.ts";
export { renderStartAppResult, StartAppResultSchema, StartedServiceResultSchema } from "./start-result.ts";

type StartAppServices =
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

const now = () => DateTime.unsafeMake(new Date().toISOString());

const appRef = (plan: AppPlan): AppRef => ({ kind: "user", id: plan.id, root: plan.root });

const endpointText = (endpoint: PublishedEndpoint & MaterializedPublishedEndpoint): string | undefined =>
  publishedEndpointUrl(endpoint);

/**
 * Start the app discovered at the runtime's `cwd`.
 *
 * Bootstrap level: `app`. Requires `LandofileService`, `AppPlanner`,
 * `RuntimeProviderRegistry`, `EventService`.
 */
export const startApp = (
  options: StartAppOptions = {},
  target?: ResolvedAppTarget,
  managed?: StartManagedScope,
  execution: { readonly forceAppBuild?: boolean } = {},
): Effect.Effect<StartAppResult, StartAppError, StartAppServices> =>
  Effect.gen(function* () {
    const landofileService = yield* LandofileService;
    const registry = yield* RuntimeProviderRegistry;
    const planner = yield* AppPlanner;
    const events = yield* EventService;
    const builds = yield* BuildOrchestrator;
    const proxy = yield* ProxyService;

    const plan =
      target?.plan ??
      (yield* Effect.gen(function* () {
        const landofile = yield* loadUserLandofile(landofileService);
        const capabilities = yield* registry.capabilities;
        return yield* planner.plan(landofile, capabilities);
      }));
    const provider = yield* registry.select(plan);
    const ref = target?.app ?? appRef(plan);
    const applyStarted = yield* Ref.make(false);
    const routesApplied = yield* Ref.make(false);

    const neededGlobalServices = requiredGlobalServicesForPlan(plan);
    if (neededGlobalServices.length > 0) {
      yield* ensureGlobalServicesRunning({
        services: neededGlobalServices,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new GlobalAutoStartError({
              message: `Failed to auto-start global services (${neededGlobalServices.join(", ")}) required by ${plan.name}.`,
              app: plan.name,
              services: [...neededGlobalServices],
              remediation: "Start the global app manually with `lando global:start`, then retry.",
              cause,
            }),
        ),
      );
    }

    return yield* withStartedHostProxy(plan, ref, provider.capabilities, {
      platform: provider.platform,
      ...(managed === undefined ? {} : { managed }),
      use: (applyPlan) =>
        Effect.gen(function* () {
          yield* events.publish(
            PreAppStartEvent.make({
              eventName: "pre-app-start",
              appRef: ref,
              providerId: plan.provider,
              timestamp: now(),
            }),
          );

          const builtPlan = yield* withBuildProvider(builds.build(applyPlan), provider);
          const serviceList = Object.values(builtPlan.services);
          const serviceIds = serviceList.map((service) => String(service.name));
          const applyParentId = `apply-${plan.id}`;
          const applyStart = performance.now();

          yield* publishTreeStart(events, {
            parentId: applyParentId,
            label: `Apply ${plan.name}`,
            children: serviceIds,
            mode: "list",
          });

          for (const service of serviceList) {
            yield* publishTaskStart(events, {
              taskId: String(service.name),
              parentId: applyParentId,
              label: `Apply service ${String(service.name)}`,
            });
          }

          const applyAndInspect = Effect.gen(function* () {
            yield* Ref.set(applyStarted, true);
            yield* Effect.scoped(
              provider.apply(builtPlan, {
                reconcile: options.reconcile ?? false,
                ...(options.signal === undefined ? {} : { signal: options.signal }),
              }),
            );
            return yield* Effect.forEach(serviceList, (service) =>
              provider.inspect({ app: plan.id, service: service.name }).pipe(
                Effect.map((runtime) => ({
                  name: String(service.name),
                  state: runtime.state ?? runtime.status,
                  endpoints: (runtime.endpoints ?? service.endpoints).flatMap((endpoint) => {
                    if (endpoint._tag === "internal") return [];
                    const rendered = endpointText(endpoint);
                    return rendered === undefined ? [] : [rendered];
                  }),
                })),
              ),
            );
          });
          const inspectedServices = yield* compensateFailure(
            applyAndInspect,
            Effect.gen(function* () {
              yield* teardownAppliedApp(provider, plan);
              for (const service of serviceList) {
                yield* publishTaskFail(events, {
                  taskId: String(service.name),
                  summary: `Apply service ${String(service.name)}`,
                  durationMs: Math.round(performance.now() - applyStart),
                });
              }
              yield* publishTreeComplete(events, {
                parentId: applyParentId,
                summary: `${plan.name} apply failed`,
                succeeded: 0,
                failed: serviceList.length,
                durationMs: Math.round(performance.now() - applyStart),
              });
            }),
          );

          for (const service of inspectedServices) {
            yield* publishTaskComplete(events, {
              taskId: service.name,
              summary: `${service.name} (${service.state})`,
              durationMs: Math.round(performance.now() - applyStart),
            });
          }

          yield* publishTreeComplete(events, {
            parentId: applyParentId,
            summary: `${plan.name} applied`,
            succeeded: serviceList.length,
            failed: 0,
            durationMs: Math.round(performance.now() - applyStart),
          });

          yield* compensateFailure(
            withBuildProvider(
              builds.buildApp(builtPlan, execution.forceAppBuild === true ? { force: true } : undefined),
              provider,
            ),
            removeRoutesAndDestroyApp(proxy, provider, plan),
          );

          yield* startFileSyncSessions(plan, events, managed).pipe((effect) =>
            compensateFailure(effect, removeRoutesAndDestroyApp(proxy, provider, plan)),
          );

          const proxyResult = yield* compensateFailure(
            applyAppRoutes(proxy, builtPlan),
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
