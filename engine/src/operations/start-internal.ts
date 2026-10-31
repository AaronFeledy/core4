import { DateTime, Effect, Option } from "effect";

import type { StartAppError as SdkStartAppError, StartAppOptions, StartAppResult } from "@lando/sdk/app";
import {
  AppPlacementError,
  type ComposeKeyRejectedError,
  FileSyncStartError,
  GlobalAutoStartError,
  type LandofileLoadExpressionError,
  ServiceNotReadyError,
} from "@lando/sdk/errors";
import { PostAppStartEvent, PostStartEvent, PreAppStartEvent, PreStartEvent } from "@lando/sdk/events";
import type { PreparedFileSyncTarget } from "@lando/sdk/schema";
import {
  type AppPlanner,
  type BuildOptions,
  BuildOrchestrator,
  EventService,
  type FileSystem,
  type GlobalAppService,
  type LandofileService,
  ManagedFileTransactionGuard,
  type PathsService,
  type PluginRegistry,
  RouterService,
  RuntimeProviderRegistry,
  type ServiceRuntimeInfo,
  type ShellRunner,
  type StateStore,
  UrlScanner,
} from "@lando/sdk/services";

import type { RedactionService } from "@lando/redaction/service";
import type { EnvironmentValueResolver } from "@lando/sdk/services";
import type { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { resolveProxyDefaultDomain } from "../config/proxy-default-domain.ts";
import { resolveRouterConfigForApp } from "../config/router-config.ts";
import type { ResolvedAppTarget } from "../landofile/app-resolution.ts";
import { mapFailureErrors } from "../lifecycle/failure-compensation.ts";
import { completeStartup } from "../lifecycle/startup-completion.ts";
import { verifyActiveVolumeCoordination } from "../lifecycle/volume-coordination.ts";
import { volumeCreationRecorder } from "../lifecycle/volume-initialization.ts";
import { taggedErrorRemediation } from "../providers/managed.ts";
import { applyWithResolvedEnvironment } from "../services/apply-environment.ts";
import { withBuildProvider } from "../services/build-orchestrator.ts";
import { readPendingAcceleratedStart } from "./accelerated-start-journal.ts";
import { verifyPendingStartResume } from "./accelerated-start-resume.ts";
import { collectPlanConnections, observeService, startedServices } from "./connection-collector.ts";
import { ensureGlobalServicesRunning, requiredGlobalServicesForPlan } from "./ensure-global-services.ts";
import { publishAndRunAppEvent, publishAndRunPostAppEvent } from "./events.ts";
import {
  acquireFileSyncEngine,
  acquirePlannedFileSyncEngine,
  requireFileSyncProvider,
  validateDesiredFileSyncEngine,
} from "./file-sync-acquire.ts";
import { fileSyncBundle } from "./file-sync-bundle.ts";
import { resolveFileSyncMountPlan } from "./file-sync-plan.ts";
import { hasExactFileSyncSessionCoverage } from "./file-sync.ts";
import { withGlobalConsumerAdmission } from "./global-consumer-admission.ts";
import { verifyGlobalConsumerAdmission } from "./global-consumer-lease.ts";
import { publishLowPortWarnings } from "./low-port-warning.ts";
import { runPostStartScan, startupScanUrls } from "./post-start-scan.ts";
import { prepareAcceleratedStart } from "./prepare-accelerated-start.ts";
import { inspectAppliedService } from "./service-readiness.ts";
import type { StartManagedScope } from "./start-file-sync.ts";
import { resolveStartGpgAgentIntent } from "./start-gpg-agent-intent.ts";
import { withStartedGpgAgent } from "./start-gpg-agent.ts";
import { withStartedHostProxy } from "./start-host-proxy.ts";
import { markStartMutation } from "./start-incomplete-notice.ts";
import { resolveStartSshAgentIntent } from "./start-ssh-agent-intent.ts";
import { withStartedSshAgent } from "./start-ssh-agent.ts";
import type { StopAppPreflight } from "./stop-internal.ts";

import { withApplyProgress, withGlobalStartProgress } from "./start-progress-phases.ts";

export type StartAppError = SdkStartAppError | ComposeKeyRejectedError | LandofileLoadExpressionError;
export type { StartAppOptions, StartAppResult } from "@lando/sdk/app";

type StartAppServices =
  | EnvironmentValueResolver
  | AppPlanner
  | BuildOrchestrator
  | EventService
  | FileSystem
  | GlobalAppService
  | LandofileService
  | ManagedFileTransactionGuard
  | PathsService
  | PluginRegistry
  | PrivateFileAccessService
  | RouterService
  | RedactionService
  | RuntimeProviderRegistry
  | ShellRunner
  | StateStore;

type BoundStartAppServices = Exclude<StartAppServices, LandofileService>;

const now = () => DateTime.nowUnsafe();

/** Private preflight shared by start, restart, and rebuild before any app hook or provider action. */
export const ensureStartTransactionConsistent = (target: ResolvedAppTarget) =>
  ManagedFileTransactionGuard.pipe(Effect.flatMap((guard) => guard.ensureConsistent(String(target.root))));

/** Verify saved accelerated ownership and clear a prior drain before init hooks can write. */
export const preflightStartAppDrain = Effect.fnUntraced(function* (
  target: ResolvedAppTarget,
  stopPreflight?: StopAppPreflight,
) {
  const bundle = yield* fileSyncBundle(target.plan);
  yield* validateDesiredFileSyncEngine(target.plan);
  if (bundle.kind === "accelerated") {
    const registry = yield* RuntimeProviderRegistry;
    yield* requireFileSyncProvider(bundle, yield* registry.select(target.plan));
  }
  const preparedTargets = yield* verifyPendingStartResume(target.app, target.plan);
  if (preparedTargets !== null) return preparedTargets;
  const prior =
    stopPreflight?.appliedFileSync ??
    (yield* Effect.gen(function* () {
      const registry = yield* RuntimeProviderRegistry;
      const provider = yield* registry.select(target.plan);
      return provider.inspectAppliedFileSync === undefined
        ? undefined
        : yield* provider.inspectAppliedFileSync(target.plan);
    }));
  if (prior === undefined) return;
  if (prior.status === "unknown") {
    return yield* Effect.fail(
      new FileSyncStartError({
        engineId: bundle.kind === "accelerated" ? bundle.id : "unavailable",
        message: "Previous file sync state could not be verified before app init hooks.",
        remediation: "Inspect and repair the provider's applied file sync state, then retry start.",
      }),
    );
  }
  if (prior.status !== "accelerated") return;
  const maybeFileSync =
    stopPreflight?.maybeFileSync ??
    (yield* acquireFileSyncEngine(prior.engineId).pipe(
      Effect.map(Option.some),
      Effect.catch(() => Effect.succeed(Option.none())),
    ));
  if (
    Option.isNone(maybeFileSync) ||
    maybeFileSync.value.id !== prior.engineId ||
    !(yield* maybeFileSync.value.isAvailable.pipe(Effect.catch(() => Effect.succeed(false))))
  ) {
    return yield* Effect.fail(
      new FileSyncStartError({
        engineId: prior.engineId,
        message: "The saved accelerated app requires its original available file sync engine.",
        remediation: "Restore the recorded file sync engine and repair its sessions before retrying start.",
      }),
    );
  }
  const lifecycle = maybeFileSync.value.appLifecycle;
  if (lifecycle === undefined) return;
  const sessions = stopPreflight?.sessions ?? (yield* maybeFileSync.value.listSessions({ app: target.app }));
  if (!hasExactFileSyncSessionCoverage(prior.sessions, sessions)) {
    return yield* Effect.fail(
      new FileSyncStartError({
        engineId: prior.engineId,
        message: "The saved accelerated app has missing or changed durable file sync sessions.",
        remediation: "Repair its owned sessions before retrying start.",
      }),
    );
  }
  yield* lifecycle.invalidateDrain(target.app);
});

export const startAppForTargetUnlocked = Effect.fnUntraced(function* (
  options: StartAppOptions | undefined,
  target: ResolvedAppTarget,
  managed?: StartManagedScope,
  execution: {
    readonly buildOptions?: BuildOptions;
    readonly forceAppBuild?: boolean;
    readonly preparedTargets?: readonly PreparedFileSyncTarget[];
  } = {},
): Effect.fn.Return<StartAppResult, SdkStartAppError, BoundStartAppServices> {
  const bundle = yield* fileSyncBundle(target.plan);
  const resolvedOptions = options ?? {};
  const registry = yield* RuntimeProviderRegistry;
  const events = yield* EventService;
  const builds = yield* BuildOrchestrator;
  const proxy = yield* RouterService;

  const candidateProvider = yield* registry.select(target.plan);
  const inspectAppliedFileSync = candidateProvider.inspectAppliedFileSync;
  const inspectPrior =
    inspectAppliedFileSync === undefined ? undefined : () => inspectAppliedFileSync(target.plan);
  const pending = yield* readPendingAcceleratedStart(target.app, target.plan);
  const resolvedPlan =
    pending !== null ? target.plan : yield* resolveFileSyncMountPlan(target.plan, inspectPrior);
  // Desired id capabilities before hooks/provider work (pending resumes keep journal identity).
  if (pending === null && bundle.kind === "accelerated") {
    yield* acquirePlannedFileSyncEngine(resolvedPlan);
  }
  const selectedProvider =
    resolvedPlan === target.plan ? candidateProvider : yield* registry.select(resolvedPlan);
  if (
    bundle.kind === "accelerated" &&
    selectedProvider.prepareFileSyncTargets !== undefined &&
    selectedProvider.inspectAppliedFileSync === undefined
  ) {
    return yield* Effect.fail(
      new FileSyncStartError({
        engineId: bundle.id,
        message: "The selected provider cannot verify previous accelerated mount state.",
        remediation:
          "Use a provider that implements both accelerated target preparation and prior-state inspection.",
      }),
    );
  }
  if (bundle.kind === "accelerated" && selectedProvider.prepareFileSyncTargets === undefined)
    return yield* Effect.fail(
      new FileSyncStartError({
        engineId: bundle.id,
        message: "The provider cannot prepare the planned accelerated targets.",
        remediation: "Restore a provider with the recorded prepared-volume lifecycle before retrying start.",
      }),
    );
  const plan = resolvedPlan;
  const engineId = bundle.kind === "accelerated" ? bundle.id : "unknown";
  const provider = selectedProvider;
  if (bundle.kind === "accelerated" && inspectPrior !== undefined) {
    const prior = yield* inspectPrior();
    if (prior.status === "accelerated" && prior.engineId !== bundle.id) {
      return yield* Effect.fail(
        new FileSyncStartError({
          engineId,
          message: "The applied app used a different file sync engine.",
          remediation: "Restore the engine recorded in provider state before restarting this app.",
        }),
      );
    }
  }
  const ref = target.app;

  yield* publishLowPortWarnings(plan);
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
  yield* publishAndRunAppEvent(plan, "pre-start", preStart);

  const neededGlobalServices = requiredGlobalServicesForPlan(plan);
  if (plan.routes.length > 0 && neededGlobalServices.includes(proxy.id) && proxy.prepare !== undefined) {
    const defaultDomain = yield* resolveProxyDefaultDomain;
    const { router, routerPin } = yield* resolveRouterConfigForApp(target.landofile?.document.router);
    yield* proxy.prepare({ defaultDomain, router, routerPin });
  }
  if (neededGlobalServices.length > 0) {
    const ensureGlobals = ensureGlobalServicesRunning({
      services: neededGlobalServices,
      ...(resolvedOptions.signal === undefined ? {} : { signal: resolvedOptions.signal }),
    }).pipe(
      mapFailureErrors((cause) =>
        cause instanceof ServiceNotReadyError || cause instanceof AppPlacementError
          ? cause
          : new GlobalAutoStartError({
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

  const sshAgentIntent = yield* resolveStartSshAgentIntent(target);
  const gpgIntent = yield* resolveStartGpgAgentIntent(target);
  yield* markStartMutation(target.plan);
  return yield* withStartedGpgAgent(plan, ref, provider.capabilities, gpgIntent, {
    exec: provider.exec,
    ...(managed === undefined ? {} : { managed }),
    use: (gpgPlan, prepareGpgHome) =>
      withStartedSshAgent(gpgPlan, ref, provider.capabilities, sshAgentIntent, {
        platform: provider.platform,
        ...(managed === undefined ? {} : { managed }),
        use: (agentPlan) =>
          withStartedHostProxy(agentPlan, ref, provider.capabilities, {
            platform: provider.platform,
            workerPlan: plan,
            reusePolicy: "exact",
            ...(managed === undefined ? {} : { managed }),
            use: Effect.fnUntraced(function* (applyPlan) {
              const builtPlan = yield* withBuildProvider(
                builds.build(applyPlan, execution.buildOptions),
                provider,
              );
              const serviceList = Object.values(builtPlan.services);
              const readyServices = yield* withGlobalConsumerAdmission(
                {
                  plan: builtPlan,
                  ...(resolvedOptions.signal === undefined ? {} : { signal: resolvedOptions.signal }),
                  ...(target.landofile?.document.router === undefined
                    ? {}
                    : { landofileRouter: target.landofile.document.router }),
                },
                Effect.gen(function* () {
                  const { pendingStart } = yield* prepareAcceleratedStart(builtPlan, provider, {
                    app: ref,
                    events,
                    managed,
                    ...(execution.preparedTargets === undefined
                      ? {}
                      : { preparedTargets: execution.preparedTargets }),
                  });

                  const initialRuntime = new Map<string, ServiceRuntimeInfo>();
                  if (pendingStart !== undefined) yield* pendingStart.advance("sessions-ready");
                  const applyAndInspect = Effect.gen(function* () {
                    yield* verifyActiveVolumeCoordination(provider);
                    if (pendingStart !== undefined) yield* pendingStart.advance("apply-intent");
                    yield* Effect.scoped(
                      applyWithResolvedEnvironment(
                        provider,
                        builtPlan,
                        {
                          reconcile: resolvedOptions.reconcile ?? false,
                          onVolumeCreated: yield* volumeCreationRecorder(provider, builtPlan),
                          ...(resolvedOptions.signal === undefined ? {} : { signal: resolvedOptions.signal }),
                        },
                        verifyGlobalConsumerAdmission,
                      ),
                    );
                    if (pendingStart !== undefined) yield* pendingStart.complete;
                    yield* prepareGpgHome;
                    return yield* Effect.forEach(serviceList, (service) =>
                      inspectAppliedService({ provider, plan: builtPlan, service: service.name }).pipe(
                        Effect.map((runtime) => {
                          initialRuntime.set(String(service.name), runtime);
                          return observeService(builtPlan, runtime);
                        }),
                      ),
                    );
                  });
                  yield* withApplyProgress({
                    events,
                    plan,
                    services: serviceList,
                    work: applyAndInspect,
                  });

                  return yield* completeStartup({
                    policy: "user-start",
                    builds,
                    router: proxy,
                    events,
                    ...(target.landofile?.document.router === undefined
                      ? {}
                      : { landofileRouter: target.landofile.document.router }),
                    ...(execution.forceAppBuild === undefined
                      ? {}
                      : { forceAppBuild: execution.forceAppBuild }),
                    provider,
                    plan: builtPlan,
                    services: serviceList.map((service) => service.name),
                    initial: initialRuntime,
                    ...(resolvedOptions.signal === undefined ? {} : { signal: resolvedOptions.signal }),
                  });
                }),
              );
              const servicesStarted = startedServices(
                yield* collectPlanConnections(builtPlan, readyServices),
              );

              yield* events.publish(
                PostAppStartEvent.make({
                  eventName: "post-app-start",
                  appRef: ref,
                  providerId: plan.provider,
                  timestamp: now(),
                }),
              );
              const postStart = PostStartEvent.make({
                _tag: "post-start",
                scope: "app",
                app: ref,
                plan,
                timestamp: now(),
              });
              yield* publishAndRunPostAppEvent(plan, "post-start", postStart);
              const scanner = yield* Effect.serviceOption(UrlScanner);
              const checks = Option.isSome(scanner)
                ? yield* runPostStartScan({
                    scanner: scanner.value,
                    plan: builtPlan,
                    events,
                    urls: startupScanUrls(builtPlan, servicesStarted),
                  })
                : undefined;

              return { app: plan.name, servicesStarted, ...(checks === undefined ? {} : { checks }) };
            }),
          }),
      }),
  });
});
