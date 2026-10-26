import { DateTime, Effect, Schema } from "effect";

import type {
  RestartAppOptions,
  RestartAppResult,
  RestartAppError as SdkRestartAppError,
} from "@lando/sdk/app";
import {
  type ComposeKeyRejectedError,
  type LandofileLoadExpressionError,
  ProviderUnavailableError,
} from "@lando/sdk/errors";
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
  type RouterService,
  RuntimeProviderRegistry,
  type ShellRunner,
  StateStore,
} from "@lando/sdk/services";

import {
  bringUpRecreateReasons,
  makeServiceRestartWouldRecreateError,
} from "@lando/container-runtime/podman/bring-up-recreate";
import type { RedactionService } from "@lando/redaction/service";
import type { EnvironmentValueResolver } from "@lando/sdk/services";
import type { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { type ResolvedAppTarget, resolveDesiredAppTarget } from "../landofile/app-resolution.ts";
import { completeStartup } from "../lifecycle/startup-completion.ts";
import { withPlanVolumeCoordination } from "../lifecycle/volume-coordination.ts";
import { volumeCreationRecorder } from "../lifecycle/volume-initialization.ts";
import { resolveMysqlVolumeTarget } from "../planner/mysql-volume.ts";
import { ensureAppPlacementState } from "../providers/app-placement.ts";
import { serviceWithArtifact } from "../services/build-artifact-runner.ts";
import { readPendingAcceleratedStart } from "./accelerated-start-journal.ts";
import { appLockTarget, withAppMutationLock } from "./app-mutation-lock.ts";
import { collectPlanConnections, startedServices } from "./connection-collector.ts";
import { publishAndRunAppEvent, runAppInitEvents } from "./events.ts";
import { publishHomeTransitionNotices, withHomeTransitionNotices } from "./home-transition-notice.ts";
import { withRetainedAgentOverlays } from "./restart-agent-overlays.ts";
import { inspectAppliedService } from "./service-readiness.ts";
import { selectInfoPlan } from "./service-selection.ts";
import { markStartMutation } from "./start-incomplete-notice.ts";
import { ensureStartTransactionConsistent, preflightStartAppDrain } from "./start-internal.ts";
import { StartAppResultSchema, type StartManagedScope, startApp } from "./start.ts";
import { preflightStopApp } from "./stop-internal.ts";
import { stopAppWithPlan } from "./stop.ts";

export type RestartAppError = SdkRestartAppError | ComposeKeyRejectedError | LandofileLoadExpressionError;
export type { RestartAppOptions, RestartAppResult } from "@lando/sdk/app";

export const RestartAppResultSchema = Schema.Struct({
  app: Schema.String,
  servicesStarted: StartAppResultSchema.fields.servicesStarted,
  checks: StartAppResultSchema.fields.checks,
});

type RestartAppServices =
  | EnvironmentValueResolver
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
  const provider = yield* registry.select(target.plan);
  const appliedPlan = yield* registry.resolveAppliedPlan(target.plan.root);
  if (
    appliedPlan === undefined ||
    appliedPlan.root !== target.plan.root ||
    appliedPlan.id !== target.plan.id ||
    appliedPlan.provider !== target.plan.provider
  ) {
    return yield* Effect.fail(
      new ProviderUnavailableError({
        providerId: String(target.plan.provider),
        operation: "restart",
        message: "Selected restart requires an ownership-matched applied plan.",
        remediation: "Start this app before restarting selected services.",
      }),
    );
  }
  const projectedServices = yield* Effect.forEach(Object.values(selectedPlan.services), (service) =>
    Effect.gen(function* () {
      const artifact = appliedPlan.services[service.name]?.artifact;
      if (artifact?.kind !== "ref" || artifact.ref.length === 0) {
        return yield* Effect.fail(
          new ProviderUnavailableError({
            providerId: String(target.plan.provider),
            operation: "restart",
            message: `Selected restart requires a concrete applied artifact for ${service.name}.`,
            remediation: `Run \`lando rebuild -s ${service.name}\` to create this service.`,
          }),
        );
      }
      return [
        service.name,
        serviceWithArtifact(service, { providerId: appliedPlan.provider, ...artifact }),
      ] as const;
    }),
  );
  const runtimePlan = yield* withRetainedAgentOverlays(
    { ...selectedPlan, services: Object.fromEntries(projectedServices) },
    target.app,
  );
  const inspectionPlan: AppPlan = {
    ...target.plan,
    services: { ...target.plan.services, ...runtimePlan.services },
  };
  const services = Object.values(runtimePlan.services);

  for (const service of services) {
    const runtime = yield* provider.inspect({
      app: target.plan.id,
      service: service.name,
      plan: inspectionPlan,
    });
    if (runtime.status === "stopped" && runtime.containerId === undefined) {
      return yield* Effect.fail(
        new ProviderUnavailableError({
          providerId: String(target.plan.provider),
          operation: "restart",
          message: `Cannot restart ${service.name} in place because its container is missing.`,
          remediation: `Run \`lando rebuild -s ${service.name}\` to create this service.`,
        }),
      );
    }
    const reasons = bringUpRecreateReasons(inspectionPlan, service, runtime, { skipAbsentFields: true });
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
  yield* publishHomeTransitionNotices(appliedPlan, selectedPlan);
  yield* markStartMutation(target.plan);

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
        yield* provider.stop({ app: target.plan.id, service: service.name, plan: target.plan });
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
    provider.apply(runtimePlan, {
      reconcile: false,
      recordedPlan: appliedPlan,
      completionPlan: target.plan,
      forbidRecreate: true,
      onVolumeCreated: yield* volumeCreationRecorder(provider, runtimePlan),
      ...(signal === undefined ? {} : { signal }),
    }),
  );
  const initial = yield* Effect.forEach(services, (service) =>
    inspectAppliedService({ provider, plan: target.plan, service: service.name }).pipe(
      Effect.map((runtime) => [String(service.name), runtime] as const),
    ),
  );
  const ready = yield* completeStartup({
    policy: "selected-restart",
    selectedPlan,
    events,
    provider,
    plan: target.plan,
    services: selected,
    initial: new Map(initial),
    ...(signal === undefined ? {} : { signal }),
  });
  const started = startedServices(yield* collectPlanConnections(target.plan, ready));

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
          const placement = yield* ensureAppPlacementState(mysqlResolvedTarget.app, plan.provider);
          const pending = yield* readPendingAcceleratedStart(mysqlResolvedTarget.app, plan);
          if (pending !== null)
            yield* startApp(
              options.signal === undefined ? {} : { signal: options.signal },
              mysqlResolvedTarget,
              managed?.resume ?? managed,
              { beforeStart: managed?.resume?.beforeStart ?? Effect.void },
            );
          const stopPreflight = yield* preflightStopApp(mysqlResolvedTarget);
          yield* preflightStartAppDrain(mysqlResolvedTarget, stopPreflight);
          yield* ensureStartTransactionConsistent(mysqlResolvedTarget);
          if (pending === null) yield* runAppInitEvents(plan);
          if (scoped) {
            return {
              app: plan.name,
              servicesStarted: yield* restartSelectedServices(selectedPlan, mysqlResolvedTarget, options),
            };
          }
          const preRestart = PreRestartEvent.make({
            _tag: "pre-restart",
            scope: "app",
            app: mysqlResolvedTarget.app,
            plan,
            triggeredBy: "app:restart",
            timestamp: DateTime.nowUnsafe(),
          });
          yield* publishAndRunAppEvent(plan, "pre-restart", preRestart);
          yield* publishHomeTransitionNotices(placement.plan, plan);
          yield* markStartMutation(plan);
          yield* stopAppWithPlan({}, mysqlResolvedTarget, { skipInitEvents: true });
          yield* managed?.onStopped ?? Effect.void;
          const result = yield* startApp(
            {
              reconcile: options.reconcile ?? false,
              ...(options.signal === undefined ? {} : { signal: options.signal }),
            },
            mysqlResolvedTarget,
            managed,
            { skipInitEvents: true, transactionPreflightDone: true },
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
    const command = withHomeTransitionNotices(effect);
    const signal = options.signal;
    if (signal === undefined) return command;
    return Effect.raceFirst(
      command,
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
