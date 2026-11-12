import type { RedactionService } from "@lando/redaction/service";

import type {
  RebuildAppOptions,
  RebuildAppResult,
  RebuildAppError as SdkRebuildAppError,
  StartAppResult,
} from "@lando/sdk/app";
import type { ComposeKeyRejectedError, LandofileLoadExpressionError } from "@lando/sdk/errors";
import { MessageInfoEvent, PostRebuildEvent, PreRebuildEvent } from "@lando/sdk/events";
import type { AppPlan, AppRef } from "@lando/sdk/schema";
import type {
  EnvironmentValueResolver,
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
  EventService,
  type LandofileService,
  type RouterService,
  type RuntimeProviderRegistry,
  StateStore,
} from "@lando/sdk/services";
import type { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { DateTime, Effect } from "effect";
import { type ResolvedAppTarget, resolveDesiredAppTarget } from "../landofile/app-resolution.ts";
import { prepareServiceCertificates } from "../lifecycle/service-certificates.ts";
import { completeStartup } from "../lifecycle/startup-completion.ts";
import { withLaunchVolumeCoordination } from "../lifecycle/volume-coordination.ts";
import { volumeCreationRecorder } from "../lifecycle/volume-initialization.ts";
import { ensureAppPlacementState } from "../providers/app-placement.ts";
import { type PreparedRuntimeProvider, selectPreparedProvider } from "../providers/prepared.ts";
import { applyWithResolvedEnvironment } from "../services/apply-environment.ts";
import { withBuildProvider } from "../services/build-orchestrator.ts";
import { readPendingAcceleratedStart } from "./accelerated-start-journal.ts";
import { appLockTarget, withAppMutationLock } from "./app-mutation-lock.ts";
import { collectPlanConnections, startedServices } from "./connection-collector.ts";
import { claimAppDataIdentity, claimDataIdentityBeforeRetirement } from "./data-identity-claim.ts";
import { reconcileAppDataIdentity } from "./data-identity-reconcile.ts";
import { publishAndRunAppEvent, runAppInitEvents } from "./events.ts";
import {
  type GlobalConsumerAdmissionServices,
  requireSelectableRouter,
  withGlobalConsumerAdmission,
} from "./global-consumer-admission.ts";
import { verifyGlobalConsumerAdmission } from "./global-consumer-lease.ts";
import { inspectAppliedService } from "./service-readiness.ts";
import { selectRebuildPlan } from "./service-selection.ts";
import { type StartManagedScope, startApp } from "./start.ts";
import { removalNotice, servicesRemovedByHalt } from "./start-convergence.ts";
import { markStartMutation } from "./start-incomplete-notice.ts";
import { ensureStartTransactionConsistent, preflightStartAppDrain } from "./start-internal.ts";
import {
  type PreparedStartOverlays,
  prepareStartOverlays,
  projectDebuggerOverlay,
  withAcquiredStartOverlays,
} from "./start-overlays.ts";
import { haltAppRuntime } from "./stop.ts";
import { preflightStopApp } from "./stop-internal.ts";
import { retireSupersededRealizations, validateSelectedRename } from "./superseded-realizations.ts";
import {
  publishPlacementVolumeTransitionNotices,
  withVolumeTransitionNotices,
} from "./volume-transition-notice.ts";

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
  selectedPlan: AppPlan,
  target: ResolvedAppTarget,
  options: Pick<RebuildAppOptions, "signal"> & {
    readonly managed?: StartManagedScope;
    readonly preparedOverlays: PreparedStartOverlays;
    readonly provider: PreparedRuntimeProvider;
  },
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
  const { signal, managed, preparedOverlays, provider } = options;
  // Prepare certificates before anything stops, so a CA failure leaves the services running.
  const plan = yield* prepareServiceCertificates(selectedPlan);
  const builds = yield* BuildOrchestrator;
  const services = Object.values(plan.services);

  const stopSelected = Effect.forEach(
    [...services].reverse(),
    // A planned service whose container is already gone needs no stop before it is rebuilt.
    (service) =>
      provider
        .stop({ app: plan.id, service: service.name, plan })
        .pipe(Effect.catchTag("ServiceNotFoundError", () => Effect.void)),
    { discard: true },
  );
  yield* markStartMutation(target.plan);
  yield* stopSelected;
  const builtPlan = yield* withBuildProvider(builds.build(plan, { refresh: true }), provider);
  const readinessPlan = { ...target.plan, services: { ...target.plan.services, ...builtPlan.services } };
  const initial = new Map<string, import("@lando/sdk/services").ServiceRuntimeInfo>();
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
      yield* withAcquiredStartOverlays({ ...target, plan: builtPlan }, preparedOverlays, {
        provider,
        workerPlan: target.plan,
        reusePolicy: "adopt",
        ...(managed === undefined ? {} : { managed }),
        use: Effect.fnUntraced(function* (applyPlan, prepareGpgHome) {
          const runtimePlan = projectDebuggerOverlay(applyPlan, preparedOverlays);
          yield* Effect.scoped(
            applyWithResolvedEnvironment(
              provider,
              runtimePlan,
              {
                reconcile: true,
                completionPlan: readinessPlan,
                recordedPlan: {
                  ...target.plan,
                  services: { ...target.plan.services, ...builtPlan.services },
                },
                ...(signal === undefined ? {} : { signal }),
                onVolumeCreated: yield* volumeCreationRecorder(provider, runtimePlan),
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
    const initialTarget = target ?? (yield* resolveDesiredAppTarget);
    const stateStore = yield* StateStore;
    return yield* withAppMutationLock(
      appLockTarget(initialTarget.plan),
      Effect.gen(function* () {
        // FIRST under root lock: reconcile before overlays, placement, retirement, or mutation.
        const resolvedTarget = yield* reconcileAppDataIdentity(initialTarget);
        const plan = resolvedTarget.plan;
        // Refuse a routed rebuild without a selectable router before stopping or building anything.
        yield* requireSelectableRouter(plan);
        const selectedPlan = yield* selectRebuildPlan(plan, options.services);
        const scoped = options.services !== undefined && options.services.length > 0;
        const placement = yield* ensureAppPlacementState(resolvedTarget.app, plan.provider);
        yield* validateSelectedRename(resolvedTarget, placement.superseded, scoped);
        const provider = yield* selectPreparedProvider(plan);
        const preparedOverlays = yield* prepareStartOverlays(
          { ...resolvedTarget, plan: selectedPlan },
          provider,
        );
        if (!scoped) yield* claimDataIdentityBeforeRetirement(resolvedTarget, placement.superseded, provider);
        const retired = yield* retireSupersededRealizations(resolvedTarget, placement.superseded, {
          provider,
          selectedServices: scoped,
        });
        return yield* withLaunchVolumeCoordination({
          plan,
          additionalPlans: placement.plan === undefined ? [] : [placement.plan],
          provider,
          stateStore,
          body: Effect.fnUntraced(function* () {
            yield* claimAppDataIdentity(resolvedTarget);
            const pending = yield* readPendingAcceleratedStart(resolvedTarget.app, plan);
            let resumedRemoved: ReadonlyArray<string> = [];
            if (pending !== null) {
              const resumed = yield* startApp(
                options.signal === undefined ? {} : { signal: options.signal },
                resolvedTarget,
                managed?.resume ?? managed,
                { beforeStart: managed?.resume?.beforeStart ?? Effect.void },
              );
              resumedRemoved = resumed.servicesRemoved ?? [];
            }
            const stopPreflight = yield* preflightStopApp(resolvedTarget);
            yield* preflightStartAppDrain(resolvedTarget, stopPreflight);
            if (!retired) yield* ensureStartTransactionConsistent(resolvedTarget);
            if (pending === null) yield* runAppInitEvents(plan);
            const ref: AppRef = resolvedTarget.app;
            const timestamp = () => DateTime.nowUnsafe();
            const preRebuild = PreRebuildEvent.make({
              _tag: "pre-rebuild",
              app: ref,
              timestamp: timestamp(),
            });
            yield* publishAndRunAppEvent(plan, "pre-rebuild", preRebuild);
            yield* publishPlacementVolumeTransitionNotices(placement, selectedPlan);
            const start: StartAppResult = scoped
              ? {
                  app: plan.name,
                  servicesStarted: yield* rebuildSelectedServices(selectedPlan, resolvedTarget, {
                    ...options,
                    provider,
                    preparedOverlays,
                    ...(managed === undefined ? {} : { managed }),
                  }),
                  ...(resumedRemoved.length === 0 ? {} : { servicesRemoved: resumedRemoved }),
                }
              : yield* Effect.gen(function* () {
                  const events = yield* EventService;
                  yield* markStartMutation(plan);
                  const observedBeforeHalt = yield* provider.list({
                    app: plan.id,
                    includeUnplanned: true,
                  });
                  const halted = yield* haltAppRuntime({}, resolvedTarget, { skipInitEvents: true });
                  const removedByHalt = servicesRemovedByHalt(halted.plan, plan, observedBeforeHalt);
                  if (removedByHalt.length > 0)
                    yield* events.publish(
                      MessageInfoEvent.make({
                        body: removalNotice(removedByHalt),
                        timestamp: timestamp(),
                      }),
                    );
                  yield* managed?.onStopped ?? Effect.void;
                  const result = yield* startApp(
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
                      preparedOverlays,
                    },
                  );
                  const servicesRemoved = [
                    ...new Set([...resumedRemoved, ...removedByHalt, ...(result.servicesRemoved ?? [])]),
                  ].sort();
                  return { ...result, servicesRemoved };
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
              ...(start.servicesRemoved === undefined ? {} : { servicesRemoved: start.servicesRemoved }),
            };
          }),
        });
      }),
    );
  },
  (effect, _options: RebuildAppOptions = {}, _target?: ResolvedAppTarget, _managed?: StartManagedScope) =>
    withVolumeTransitionNotices(effect),
);
