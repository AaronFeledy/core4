import { DateTime, Effect } from "effect";

import type {
  RebuildAppOptions,
  RebuildAppResult,
  RebuildAppError as SdkRebuildAppError,
} from "@lando/sdk/app";
import type { ComposeKeyRejectedError, LandofileLoadExpressionError } from "@lando/sdk/errors";
import type {
  FileSystem,
  GlobalAppService,
  ManagedFileTransactionGuard,
  PathsService,
  PluginRegistry,
  ShellRunner,
} from "@lando/sdk/services";
import {
  type AppPlanner,
  BuildOrchestrator,
  type EventService,
  type LandofileService,
  type RouterService,
  RuntimeProviderRegistry,
  StateStore,
} from "@lando/sdk/services";

import type { RedactionService } from "@lando/redaction/service";
import { PostRebuildEvent, PreRebuildEvent } from "@lando/sdk/events";
import type { AppPlan, AppRef } from "@lando/sdk/schema";
import type { EnvironmentValueResolver } from "@lando/sdk/services";
import type { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { type ResolvedAppTarget, resolveDesiredAppTarget } from "../landofile/app-resolution.ts";
import { completeStartup } from "../lifecycle/startup-completion.ts";
import { withPlanVolumeCoordination } from "../lifecycle/volume-coordination.ts";
import { volumeCreationRecorder } from "../lifecycle/volume-initialization.ts";
import { resolveMysqlVolumeTarget } from "../planner/mysql-volume.ts";
import { ensureAppPlacementState } from "../providers/app-placement.ts";
import { applyWithResolvedEnvironment } from "../services/apply-environment.ts";
import { withBuildProvider } from "../services/build-orchestrator.ts";
import { readPendingAcceleratedStart } from "./accelerated-start-journal.ts";
import { appLockTarget, withAppMutationLock } from "./app-mutation-lock.ts";
import { collectPlanConnections, startedServices } from "./connection-collector.ts";
import { publishAndRunAppEvent, runAppInitEvents } from "./events.ts";
import {
  type GlobalConsumerAdmissionServices,
  withGlobalConsumerAdmission,
} from "./global-consumer-admission.ts";
import { verifyGlobalConsumerAdmission } from "./global-consumer-lease.ts";
import { publishHomeTransitionNotices, withHomeTransitionNotices } from "./home-transition-notice.ts";
import { inspectAppliedService } from "./service-readiness.ts";
import { selectRebuildPlan } from "./service-selection.ts";
import { resolveStartGpgAgentIntent } from "./start-gpg-agent-intent.ts";
import { withStartedGpgAgent } from "./start-gpg-agent.ts";
import { withStartedHostProxy } from "./start-host-proxy.ts";
import { markStartMutation } from "./start-incomplete-notice.ts";
import { ensureStartTransactionConsistent, preflightStartAppDrain } from "./start-internal.ts";
import { resolveStartSshAgentIntent } from "./start-ssh-agent-intent.ts";
import { withStartedSshAgent } from "./start-ssh-agent.ts";
import { type StartManagedScope, startApp } from "./start.ts";
import { preflightStopApp } from "./stop-internal.ts";
import { stopAppWithPlan } from "./stop.ts";

export type RebuildAppError = SdkRebuildAppError | ComposeKeyRejectedError | LandofileLoadExpressionError;
export type { RebuildAppOptions, RebuildAppResult } from "@lando/sdk/app";

type RebuildAppServices =
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

const rebuildSelectedServices = Effect.fnUntraced(function* (
  plan: AppPlan,
  target: ResolvedAppTarget,
  options: Pick<RebuildAppOptions, "signal"> & { readonly managed?: StartManagedScope },
): Effect.fn.Return<
  RebuildAppResult["servicesStarted"],
  RebuildAppError,
  | BuildOrchestrator
  | RouterService
  | EnvironmentValueResolver
  | RuntimeProviderRegistry
  | EventService
  | PathsService
  | PrivateFileAccessService
  | ShellRunner
  | RedactionService
  | GlobalConsumerAdmissionServices
> {
  const { signal, managed } = options;
  const registry = yield* RuntimeProviderRegistry;
  const builds = yield* BuildOrchestrator;
  const provider = yield* registry.select(plan);
  const services = Object.values(plan.services);

  const stopSelected = Effect.forEach(
    [...services].reverse(),
    (service) => provider.stop({ app: plan.id, service: service.name, plan }),
    { discard: true },
  );
  yield* markStartMutation(target.plan);
  yield* stopSelected;
  const builtPlan = yield* withBuildProvider(builds.build(plan, { refresh: true }), provider);
  const readinessPlan = { ...target.plan, services: { ...target.plan.services, ...builtPlan.services } };
  const initial = new Map<string, import("@lando/sdk/services").ServiceRuntimeInfo>();
  const gpgIntent = yield* resolveStartGpgAgentIntent({ ...target, plan: builtPlan });
  const intent = yield* resolveStartSshAgentIntent({ ...target, plan: builtPlan });
  return yield* withGlobalConsumerAdmission(
    {
      plan: readinessPlan,
      setupRouter: true,
      ...(signal === undefined ? {} : { signal }),
      ...(target.landofile?.document.router === undefined
        ? {}
        : { landofileRouter: target.landofile.document.router }),
    },
    Effect.gen(function* () {
      yield* withStartedGpgAgent(builtPlan, target.app, provider.capabilities, gpgIntent, {
        exec: provider.exec,
        ...(managed === undefined ? {} : { managed }),
        use: (gpgPlan, prepareGpgHome) =>
          withStartedSshAgent(gpgPlan, target.app, provider.capabilities, intent, {
            platform: provider.platform,
            ...(managed === undefined ? {} : { managed }),
            use: (agentPlan) =>
              withStartedHostProxy(agentPlan, target.app, provider.capabilities, {
                platform: provider.platform,
                workerPlan: target.plan,
                reusePolicy: "adopt",
                ...(managed === undefined ? {} : { managed }),
                use: Effect.fnUntraced(function* (applyPlan) {
                  yield* Effect.scoped(
                    applyWithResolvedEnvironment(
                      provider,
                      applyPlan,
                      {
                        reconcile: true,
                        completionPlan: readinessPlan,
                        recordedPlan: {
                          ...target.plan,
                          services: { ...target.plan.services, ...builtPlan.services },
                        },
                        ...(signal === undefined ? {} : { signal }),
                        onVolumeCreated: yield* volumeCreationRecorder(provider, applyPlan),
                      },
                      verifyGlobalConsumerAdmission,
                    ),
                  );
                  yield* prepareGpgHome;
                  yield* Effect.forEach(services, (service) =>
                    inspectAppliedService({ provider, plan: readinessPlan, service: service.name }).pipe(
                      Effect.tap((runtime) => Effect.sync(() => initial.set(String(service.name), runtime))),
                    ),
                  );
                }),
              }),
          }),
      });
      const ready = yield* completeStartup({
        policy: "selected-rebuild",
        builds,
        selectedPlan: builtPlan,
        provider,
        plan: readinessPlan,
        services: services.map((service) => service.name),
        initial,
        ...(signal === undefined ? {} : { signal }),
      });
      return startedServices(yield* collectPlanConnections(readinessPlan, ready));
    }),
  );
});

export const rebuildApp = Effect.fn("AppOperation.rebuild")(
  function* (
    options: RebuildAppOptions = {},
    target?: ResolvedAppTarget,
    managed?: StartManagedScope,
  ): Effect.fn.Return<RebuildAppResult, RebuildAppError, RebuildAppServices> {
    const plannedTarget = target ?? (yield* resolveDesiredAppTarget);
    const placement = yield* ensureAppPlacementState(plannedTarget.app, plannedTarget.plan.provider);
    const registry = yield* RuntimeProviderRegistry;
    const resolvedTarget = yield* resolveMysqlVolumeTarget(plannedTarget, registry);
    const plan = resolvedTarget.plan;
    const selectedPlan = yield* selectRebuildPlan(plan, options.services);
    const scoped = options.services !== undefined && options.services.length > 0;
    const context = yield* Effect.context<RebuildAppServices>();
    const stateStore = yield* StateStore;
    const provider = yield* registry.select(plan);
    return yield* withAppMutationLock(
      appLockTarget(plan),
      withPlanVolumeCoordination({
        plan,
        provider,
        stateStore,
        body: Effect.fnUntraced(function* () {
          const pending = yield* readPendingAcceleratedStart(resolvedTarget.app, plan);
          if (pending !== null)
            yield* startApp(
              options.signal === undefined ? {} : { signal: options.signal },
              resolvedTarget,
              managed?.resume ?? managed,
              { beforeStart: managed?.resume?.beforeStart ?? Effect.void },
            );
          const stopPreflight = yield* preflightStopApp(resolvedTarget);
          yield* preflightStartAppDrain(resolvedTarget, stopPreflight);
          yield* ensureStartTransactionConsistent(resolvedTarget);
          if (pending === null) yield* runAppInitEvents(plan);
          const ref: AppRef = resolvedTarget.app;
          const timestamp = () => DateTime.nowUnsafe();
          const preRebuild = PreRebuildEvent.make({
            _tag: "pre-rebuild",
            app: ref,
            timestamp: timestamp(),
          });
          yield* publishAndRunAppEvent(plan, "pre-rebuild", preRebuild);
          yield* publishHomeTransitionNotices(placement.plan, selectedPlan);
          const start = scoped
            ? {
                app: plan.name,
                servicesStarted: yield* rebuildSelectedServices(selectedPlan, resolvedTarget, {
                  ...options,
                  ...(managed === undefined ? {} : { managed }),
                }),
              }
            : yield* Effect.gen(function* () {
                yield* markStartMutation(plan);
                yield* stopAppWithPlan({}, resolvedTarget, { skipInitEvents: true });
                yield* managed?.onStopped ?? Effect.void;
                return yield* startApp(
                  {
                    reconcile: true,
                    ...(options.signal === undefined ? {} : { signal: options.signal }),
                  },
                  resolvedTarget,
                  managed,
                  {
                    buildOptions: { refresh: true },
                    forceAppBuild: true,
                    skipInitEvents: true,
                    transactionPreflightDone: true,
                  },
                );
              });
          const postRebuild = PostRebuildEvent.make({
            _tag: "post-rebuild",
            app: ref,
            timestamp: timestamp(),
          });
          yield* publishAndRunAppEvent(plan, "post-rebuild", postRebuild);
          return {
            app: start.app,
            servicesRebuilt: start.servicesStarted.map((service) => service.name),
            servicesStarted: start.servicesStarted,
            ...(start.checks === undefined ? {} : { checks: start.checks }),
          };
        }, Effect.provide(context)),
      }),
    );
  },
  (effect, _options: RebuildAppOptions = {}, _target?: ResolvedAppTarget, _managed?: StartManagedScope) =>
    withHomeTransitionNotices(effect),
);
