import { DateTime, Effect, Schema } from "effect";

import type {
  RestartAppOptions,
  RestartAppResult,
  RestartAppError as SdkRestartAppError,
} from "@lando/sdk/app";
import type { ComposeKeyRejectedError, LandofileLoadExpressionError } from "@lando/sdk/errors";
import {
  PostRestartEvent,
  PostServiceStopEvent,
  PreRestartEvent,
  PreServiceStopEvent,
} from "@lando/sdk/events";
import type { AppPlan } from "@lando/sdk/schema";
import {
  type AppPlanner,
  type BuildOrchestrator,
  EventService,
  type FileSystem,
  type GlobalAppService,
  type LandofileService,
  type ManagedFileTransactionGuard,
  type PathsService,
  type PluginRegistry,
  RouterService,
  RuntimeProviderRegistry,
  type ShellRunner,
  StateStore,
} from "@lando/sdk/services";

import {
  bringUpRecreateReasons,
  makeServiceRestartWouldRecreateError,
} from "@lando/container-runtime/podman/bring-up-recreate";
import type { RedactionService } from "@lando/redaction/service";
import type { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { type ResolvedAppTarget, resolveDesiredAppTarget } from "../landofile/app-resolution.ts";
import { compensateFailureUnless } from "../lifecycle/failure-compensation.ts";
import { routeUrlsForPlan } from "../lifecycle/routes.ts";
import { withPlanVolumeCoordination } from "../lifecycle/volume-coordination.ts";
import { resolveMysqlVolumeTarget } from "../planner/mysql-volume.ts";
import { isPostStartStepError } from "../tooling/event-errors.ts";
import { requireNoPendingAcceleratedStart } from "./accelerated-start-journal.ts";
import { appLockTarget, withAppMutationLock } from "./app-mutation-lock.ts";
import { startedServiceRow } from "./authority-url.ts";
import { publishAndRunAppEvent, runAppInitEvents } from "./events.ts";
import { selectInfoPlan } from "./service-selection.ts";
import { startFileSyncSessions } from "./start-file-sync.ts";
import { ensureStartTransactionConsistent, preflightStartAppDrain } from "./start-internal.ts";
import { type StartManagedScope, StartedServiceResultSchema, startApp } from "./start.ts";
import { preflightStopApp } from "./stop-internal.ts";
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
  | ShellRunner
  | StateStore;

const restartSelectedServices = Effect.fnUntraced(function* (
  selectedPlan: AppPlan,
  target: ResolvedAppTarget,
  options: Pick<RestartAppOptions, "signal">,
): Effect.fn.Return<RestartAppResult["servicesStarted"], RestartAppError, RestartAppServices> {
  const { signal } = options;
  const events = yield* EventService;
  const registry = yield* RuntimeProviderRegistry;
  const proxy = yield* RouterService;
  const provider = yield* registry.select(target.plan);
  const services = Object.values(selectedPlan.services);

  for (const service of services) {
    const runtime = yield* provider.inspect({
      app: target.plan.id,
      service: service.name,
      plan: target.plan,
    });
    const reasons = bringUpRecreateReasons(target.plan, service, runtime, { skipAbsentFields: true });
    if (reasons[0] !== undefined) {
      return yield* Effect.fail(
        makeServiceRestartWouldRecreateError({
          providerId: String(target.plan.provider),
          service: String(service.name),
          reason: reasons[0],
        }),
      );
    }
  }

  const selected = services.map((service) => service.name);
  const preRestart = PreRestartEvent.make({
    _tag: "pre-restart",
    scope: "app",
    app: target.app,
    plan: target.plan,
    triggeredBy: "app:restart",
    timestamp: DateTime.nowUnsafe(),
    services: [...selected],
  });
  yield* publishAndRunAppEvent(target.plan, "pre-restart", preRestart);

  yield* Effect.forEach(
    [...services].reverse(),
    (service) =>
      Effect.gen(function* () {
        if (signal?.aborted === true) return yield* Effect.interrupt;
        yield* events.publish(
          PreServiceStopEvent.make({
            eventName: "pre-service-stop",
            appRef: target.app,
            serviceName: service.name,
            providerId: target.plan.provider,
            timestamp: DateTime.nowUnsafe(),
          }),
        );
        yield* provider
          .stop({ app: target.plan.id, service: service.name, plan: target.plan })
          .pipe(Effect.catchTag("ServiceNotFoundError", () => Effect.void));
        yield* events.publish(
          PostServiceStopEvent.make({
            eventName: "post-service-stop",
            appRef: target.app,
            serviceName: service.name,
            providerId: target.plan.provider,
            timestamp: DateTime.nowUnsafe(),
          }),
        );
      }),
    { discard: true },
  );

  if (signal?.aborted === true) return yield* Effect.interrupt;
  yield* Effect.scoped(
    provider.apply(selectedPlan, {
      reconcile: false,
      recordedPlan: target.plan,
      forbidRecreate: true,
      ...(signal === undefined ? {} : { signal }),
    }),
  );
  yield* startFileSyncSessions(selectedPlan, events);

  const routedUrls = yield* routeUrlsForPlan(proxy, target.plan);
  const started = yield* Effect.forEach(services, (service) =>
    provider.inspect({ app: target.plan.id, service: service.name, plan: target.plan }).pipe(
      Effect.map((runtime) => {
        const row = startedServiceRow(service, runtime);
        return {
          ...row,
          endpoints: [...(routedUrls.get(service.name) ?? []), ...row.endpoints],
        };
      }),
    ),
  );

  const postRestart = PostRestartEvent.make({
    _tag: "post-restart",
    scope: "app",
    app: target.app,
    plan: target.plan,
    timestamp: DateTime.nowUnsafe(),
    services: [...selected],
  });
  yield* publishAndRunAppEvent(target.plan, "post-restart", postRestart);
  return started;
});

export const restartApp = Effect.fn("AppOperation.restart")(
  function* (
    options: RestartAppOptions = {},
    target?: ResolvedAppTarget,
    managed?: StartManagedScope,
  ): Effect.fn.Return<RestartAppResult, RestartAppError, RestartAppServices> {
    if (options.signal?.aborted === true) return yield* Effect.interrupt;
    const resolvedTarget = target ?? (yield* resolveDesiredAppTarget);
    const registry = yield* RuntimeProviderRegistry;
    const mysqlResolvedTarget = yield* resolveMysqlVolumeTarget(resolvedTarget, registry);
    const plan = mysqlResolvedTarget.plan;
    const scoped = options.services !== undefined && options.services.length > 0;
    const selectedPlan = scoped ? yield* selectInfoPlan(plan, options.services) : plan;
    const context = yield* Effect.context<RestartAppServices>();
    const stateStore = yield* StateStore;
    const provider = yield* registry.select(plan);
    return yield* withAppMutationLock(
      appLockTarget(plan),
      withPlanVolumeCoordination({
        plan,
        provider,
        stateStore,
        body: Effect.fnUntraced(function* () {
          yield* requireNoPendingAcceleratedStart(mysqlResolvedTarget.app, plan);
          const stopPreflight = yield* preflightStopApp(mysqlResolvedTarget);
          yield* preflightStartAppDrain(mysqlResolvedTarget, stopPreflight);
          yield* ensureStartTransactionConsistent(mysqlResolvedTarget);
          yield* runAppInitEvents(plan);
          if (scoped) {
            return {
              app: plan.name,
              servicesStarted: yield* restartSelectedServices(selectedPlan, mysqlResolvedTarget, options),
            };
          }
          const proxy = yield* RouterService;
          const preRestart = PreRestartEvent.make({
            _tag: "pre-restart",
            scope: "app",
            app: mysqlResolvedTarget.app,
            plan,
            triggeredBy: "app:restart",
            timestamp: DateTime.nowUnsafe(),
          });
          yield* publishAndRunAppEvent(plan, "pre-restart", preRestart);
          yield* stopAppWithPlan({}, mysqlResolvedTarget, { skipInitEvents: true });
          yield* managed?.onStopped ?? Effect.void;
          const result = yield* compensateFailureUnless(
            startApp(
              {
                reconcile: options.reconcile ?? false,
                ...(options.signal === undefined ? {} : { signal: options.signal }),
              },
              mysqlResolvedTarget,
              managed,
              { skipInitEvents: true, transactionPreflightDone: true },
            ),
            proxy.removeRoutes(plan.id),
            isPostStartStepError,
          );
          const postRestart = PostRestartEvent.make({
            _tag: "post-restart",
            scope: "app",
            app: mysqlResolvedTarget.app,
            plan,
            timestamp: DateTime.nowUnsafe(),
          });
          yield* publishAndRunAppEvent(plan, "post-restart", postRestart);
          return result;
        }, Effect.provide(context)),
      }),
    );
  },
  (effect, options: RestartAppOptions = {}, _target?: ResolvedAppTarget, _managed?: StartManagedScope) => {
    const signal = options.signal;
    if (signal === undefined) return effect;
    return Effect.raceFirst(
      effect,
      Effect.callback<never>((resume) => {
        const abort = () => resume(Effect.interrupt);
        if (signal.aborted) {
          abort();
          return;
        }
        signal.addEventListener("abort", abort, { once: true });
        return Effect.sync(() => signal.removeEventListener("abort", abort));
      }),
    );
  },
);
