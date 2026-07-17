/**
 * `lando start` — start the current app.
 *
 * Bootstrap level: `app`.
 *
 * Programmatic equivalent: `startApp({ reconcile: false })` from
 * `@lando/core/cli`.
 */
import { DateTime, Effect, Ref, Schema } from "effect";

import type { StartAppError, StartAppOptions, StartAppResult } from "@lando/sdk/app";
import { GlobalAutoStartError } from "@lando/sdk/errors";
import { PostAppStartEvent, PreAppStartEvent } from "@lando/sdk/events";
import type { AppPlan, AppRef } from "@lando/sdk/schema";
import {
  AppPlanner,
  BuildOrchestrator,
  EventService,
  type FileSystem,
  type GlobalAppService,
  LandofileService,
  type PathsService,
  type PluginRegistry,
  RuntimeProviderRegistry,
  type RuntimeProviderShape,
  type ShellRunner,
} from "@lando/sdk/services";

import type { RedactionService } from "../../redaction/service.ts";
import { type ResolvedAppTarget, loadUserLandofile } from "../app-resolution.ts";
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
  | RedactionService
  | RuntimeProviderRegistry
  | ShellRunner;

const now = () => DateTime.unsafeMake(new Date().toISOString());

const appRef = (plan: AppPlan): AppRef => ({ kind: "user", id: plan.id, root: plan.root });

const endpointText = (endpoint: {
  readonly protocol: string;
  readonly port?: number | undefined;
  readonly socketPath?: string | undefined;
}) => {
  if (endpoint.socketPath !== undefined) return `${endpoint.protocol}:${endpoint.socketPath}`;
  if (endpoint.port === undefined) return endpoint.protocol;
  return `${endpoint.protocol}://localhost:${endpoint.port}`;
};

const READY_STATES = new Set(["running", "ready"]);

const isStartAppReady = (result: StartAppResult): boolean =>
  result.servicesStarted.length > 0 &&
  result.servicesStarted.every((service) => READY_STATES.has(service.state));

const rollbackAppliedApp = (provider: RuntimeProviderShape, plan: AppPlan) =>
  provider
    .destroy({ app: plan.id, plan }, { volumes: true, removeState: true })
    .pipe(Effect.catchAll(() => Effect.void));

export const renderStartAppResult = (result: StartAppResult): string => {
  const services = result.servicesStarted
    .map((service) => {
      const endpoints = service.endpoints.length === 0 ? "no endpoints" : service.endpoints.join(", ");
      return `${service.name} (${service.state}) ${endpoints}`;
    })
    .join("; ");
  const prefix = isStartAppReady(result) ? "ready" : "starting";
  return `${prefix}: ${result.app}${services.length === 0 ? "" : ` - ${services}`}`;
};

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
): Effect.Effect<StartAppResult, StartAppError, StartAppServices> =>
  Effect.gen(function* () {
    const landofileService = yield* LandofileService;
    const registry = yield* RuntimeProviderRegistry;
    const planner = yield* AppPlanner;
    const events = yield* EventService;
    const builds = yield* BuildOrchestrator;

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

          const builtPlan = yield* builds.build(applyPlan);
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
                  endpoints: (runtime.endpoints ?? service.endpoints).map(endpointText),
                })),
              ),
            );
          });
          const servicesStarted = yield* applyAndInspect.pipe(
            Effect.tapError(() =>
              Effect.gen(function* () {
                yield* rollbackAppliedApp(provider, plan);
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
            ),
          );

          for (const service of servicesStarted) {
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

          yield* builds.buildApp(builtPlan);

          yield* startFileSyncSessions(plan, events, managed).pipe(
            Effect.tapError(() =>
              Effect.gen(function* () {
                yield* rollbackAppliedApp(provider, plan);
              }),
            ),
          );

          yield* events.publish(
            PostAppStartEvent.make({
              eventName: "post-app-start",
              appRef: ref,
              providerId: plan.provider,
              timestamp: now(),
            }),
          );

          return { app: plan.name, servicesStarted };
        }),
    }).pipe(
      Effect.onInterrupt(() =>
        Ref.get(applyStarted).pipe(
          Effect.flatMap((started) => (started ? rollbackAppliedApp(provider, plan) : Effect.void)),
        ),
      ),
    );
  });
