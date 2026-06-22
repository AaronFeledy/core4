/**
 * `lando start` — start the current app.
 *
 * Bootstrap level: `app`.
 *
 * Programmatic equivalent: `startApp({ reconcile: false })` from
 * `@lando/core/cli`.
 */
import { DateTime, Effect, Scope } from "effect";

import type { StartAppError, StartAppOptions, StartAppResult } from "@lando/sdk/app";
import { GlobalAutoStartError } from "@lando/sdk/errors";
import { PostAppStartEvent, PreAppStartEvent } from "@lando/sdk/events";
import type { AppPlan, AppRef, FileSyncSessionRef } from "@lando/sdk/schema";
import {
  AppPlanner,
  EventService,
  FileSyncEngine,
  type FileSystem,
  type GlobalAppService,
  LandofileService,
  type PluginRegistry,
  RuntimeProviderRegistry,
  type RuntimeProviderShape,
} from "@lando/sdk/services";

import { loadUserLandofile } from "../app-resolution.ts";
import { ensureGlobalServicesRunning, requiredGlobalServicesForPlan } from "./meta/ensure-global-services.ts";

import {
  type ProgressEmitter,
  publishTaskComplete,
  publishTaskDetail,
  publishTaskFail,
  publishTaskStart,
  publishTreeComplete,
  publishTreeStart,
} from "../progress.ts";

export type { StartAppError, StartAppOptions, StartAppResult } from "@lando/sdk/app";

type StartAppServices =
  | AppPlanner
  | EventService
  | FileSystem
  | GlobalAppService
  | LandofileService
  | PluginRegistry
  | RuntimeProviderRegistry;

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

const startFileSyncSessions = (plan: AppPlan, events: ProgressEmitter) =>
  Effect.gen(function* () {
    if (plan.fileSync.length === 0) return;
    const engineOption = yield* Effect.serviceOption(FileSyncEngine);
    if (engineOption._tag === "None") return;

    const engine = engineOption.value;
    if (!(yield* engine.isAvailable)) {
      yield* publishTaskDetail(events, {
        taskId: "file-sync",
        stream: "stdout",
        line: "Completing deferred file-sync setup for accelerated mounts.",
      });
      // Swallow setup failure: propagating it reaches `rollbackAppliedApp`,
      // which would destroy the just-applied app over a transient download blip.
      const setupSucceeded = yield* Effect.scoped(engine.setup({ force: false })).pipe(
        Effect.as(true),
        Effect.catchAll(() =>
          publishTaskDetail(events, {
            taskId: "file-sync",
            stream: "stderr",
            line: "Deferred file-sync setup failed; continuing without accelerated mounts.",
          }).pipe(Effect.as(false)),
        ),
      );
      if (!setupSucceeded || !(yield* engine.isAvailable)) return;
    }

    const createdRefs: Array<FileSyncSessionRef> = [];
    const resumedPausedRefs: Array<FileSyncSessionRef> = [];
    yield* Effect.forEach(
      plan.fileSync,
      (entry) =>
        Effect.gen(function* () {
          const existingSessions = yield* engine.listSessions({
            app: entry.session.app,
            service: entry.session.service,
            mountKey: entry.session.mountKey,
          });
          const existingSession = existingSessions[0];
          if (existingSession !== undefined) {
            if (existingSession.status === "paused") {
              yield* engine.resumeSession(existingSession.ref);
              resumedPausedRefs.push(existingSession.ref);
            }
            if (existingSession.status === "running" || existingSession.status === "paused") return;
          }

          const sessionScope = yield* Scope.make();
          const ref = yield* engine
            .createSession(entry.session)
            .pipe(Effect.provideService(Scope.Scope, sessionScope));
          createdRefs.push(ref);
        }),
      { discard: true },
    ).pipe(
      Effect.catchAll((error) =>
        Effect.forEach(
          [...createdRefs].reverse(),
          (ref) => engine.terminateSession(ref).pipe(Effect.catchAll(() => Effect.void)),
          { discard: true },
        ).pipe(
          Effect.zipRight(
            Effect.forEach(
              [...resumedPausedRefs].reverse(),
              (ref) => engine.pauseSession(ref).pipe(Effect.catchAll(() => Effect.void)),
              { discard: true },
            ),
          ),
          Effect.flatMap(() => Effect.fail(error)),
        ),
      ),
    );
  });

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
): Effect.Effect<StartAppResult, StartAppError, StartAppServices> =>
  Effect.gen(function* () {
    const landofileService = yield* LandofileService;
    const registry = yield* RuntimeProviderRegistry;
    const planner = yield* AppPlanner;
    const events = yield* EventService;

    const landofile = yield* loadUserLandofile(landofileService);
    const capabilities = yield* registry.capabilities;
    const plan = yield* planner.plan(landofile, capabilities);
    const provider = yield* registry.select(plan);
    const ref = appRef(plan);

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

    const serviceList = Object.values(plan.services);
    const serviceIds = serviceList.map((service) => String(service.name));
    const applyParentId = `apply-${plan.id}`;
    const applyStart = performance.now();

    yield* events.publish(
      PreAppStartEvent.make({
        eventName: "pre-app-start",
        appRef: ref,
        providerId: plan.provider,
        timestamp: now(),
      }),
    );

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
      yield* Effect.scoped(
        provider.apply(plan, {
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
      summary: `${plan.name} ready`,
      succeeded: serviceList.length,
      failed: 0,
      durationMs: Math.round(performance.now() - applyStart),
    });

    yield* startFileSyncSessions(plan, events).pipe(
      Effect.tapError(() => rollbackAppliedApp(provider, plan)),
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
  });
