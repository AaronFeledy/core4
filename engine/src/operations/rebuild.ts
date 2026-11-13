import type { RedactionService } from "@lando/redaction/service";

import type {
  RebuildAppOptions,
  RebuildAppResult,
  RebuildAppError as SdkRebuildAppError,
  StartAppResult,
} from "@lando/sdk/app";
import type { ComposeKeyRejectedError, LandofileLoadExpressionError } from "@lando/sdk/errors";
import { PostRebuildEvent, PreRebuildEvent } from "@lando/sdk/events";
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
  type EventService,
  type LandofileService,
  type RouterService,
  type RuntimeProviderRegistry,
  type StateStore,
} from "@lando/sdk/services";
import type { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { DateTime, Effect } from "effect";
import { type ResolvedAppTarget, resolveDesiredAppTarget } from "../landofile/app-resolution.ts";
import { applyActivation } from "../lifecycle/activation-apply.ts";
import { prepareServiceCertificates } from "../lifecycle/service-certificates.ts";
import { completeStartup } from "../lifecycle/startup-completion.ts";
import { withBuildProvider } from "../services/build-orchestrator.ts";
import { type AdmittedServices, withAppActivation } from "./app-activation.ts";
import { haltAndRelaunchApp } from "./app-relaunch.ts";
import { collectPlanConnections, startedServices } from "./connection-collector.ts";
import { publishAndRunAppEvent } from "./events.ts";
import {
  type GlobalConsumerAdmissionServices,
  withGlobalConsumerAdmission,
} from "./global-consumer-admission.ts";
import { verifyGlobalConsumerAdmission } from "./global-consumer-lease.ts";
import { inspectAppliedService } from "./service-readiness.ts";
import type { StartManagedScope } from "./start-file-sync.ts";
import { markStartMutation } from "./start-incomplete-notice.ts";
import {
  type PreparedStartOverlays,
  projectDebuggerOverlay,
  withAcquiredStartOverlays,
} from "./start-overlays.ts";
import { publishPlacementVolumeTransitionNotices } from "./volume-transition-notice.ts";

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
  admitted: AdmittedServices<PreparedStartOverlays>,
  options: Pick<RebuildAppOptions, "signal"> & {
    readonly managed?: StartManagedScope;
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
  const { signal, managed } = options;
  const { selectedPlan, target, provider, overlays: preparedOverlays } = admitted;
  // Prepare certificates before anything stops, so a CA failure leaves the services running.
  const { plan, certificates } = yield* prepareServiceCertificates(selectedPlan);
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
          yield* applyActivation({
            provider,
            plan: runtimePlan,
            certificates,
            reconcile: true,
            completionPlan: readinessPlan,
            recordedPlan: readinessPlan,
            ...(signal === undefined ? {} : { signal }),
            beforeApply: verifyGlobalConsumerAdmission,
          });
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

export const rebuildApp = Effect.fn("AppOperation.rebuild")(function* (
  options: RebuildAppOptions = {},
  target?: ResolvedAppTarget,
  managed?: StartManagedScope,
): Effect.fn.Return<RebuildAppResult, RebuildAppError, RebuildAppServices> {
  const initialTarget = target ?? (yield* resolveDesiredAppTarget);
  return yield* withAppActivation(
    {
      operation: "rebuild",
      target: initialTarget,
      services: options.services,
      signal: options.signal,
      managed,
    },
    Effect.fnUntraced(function* (admitted) {
      const { target: resolvedTarget, placement, removedByResume } = admitted;
      const plan = resolvedTarget.plan;
      const selectedPlan = admitted.scope === "services" ? admitted.selectedPlan : plan;
      const ref = resolvedTarget.app;
      const preRebuild = PreRebuildEvent.make({
        _tag: "pre-rebuild",
        app: ref,
        timestamp: DateTime.nowUnsafe(),
      });
      yield* publishAndRunAppEvent(plan, "pre-rebuild", preRebuild);
      yield* publishPlacementVolumeTransitionNotices(placement, selectedPlan);
      const start: StartAppResult =
        admitted.scope === "services"
          ? {
              app: plan.name,
              servicesStarted: yield* rebuildSelectedServices(admitted, {
                ...options,
                ...(managed === undefined ? {} : { managed }),
              }),
              ...(removedByResume.length === 0 ? {} : { servicesRemoved: removedByResume }),
            }
          : yield* haltAndRelaunchApp(
              admitted,
              {
                reconcile: true,
                ...(options.signal === undefined ? {} : { signal: options.signal }),
              },
              managed,
              { buildOptions: { refresh: true }, forceAppBuild: true },
            );
      const postRebuild = PostRebuildEvent.make({
        _tag: "post-rebuild",
        app: ref,
        timestamp: DateTime.nowUnsafe(),
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
  );
});
