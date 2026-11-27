import { observeTcpListener } from "@lando/container-runtime/listener-observation";
import { adoptionReceiptsFromSummary } from "@lando/container-runtime/native-ownership";
import type { RedactionService } from "@lando/redaction/service";
import type { StartAppError as SdkStartAppError, StartAppOptions, StartAppResult } from "@lando/sdk/app";
import { causeRemediation } from "@lando/sdk/command-result";
import {
  AppPlacementError,
  type ComposeKeyRejectedError,
  FileSyncStartError,
  GlobalAutoStartError,
  type GpgAgentTransportError,
  type LandofileLoadExpressionError,
  ServiceNotReadyError,
} from "@lando/sdk/errors";
import { PostAppStartEvent, PostStartEvent, PreAppStartEvent, PreStartEvent } from "@lando/sdk/events";
import type { AppPlan, PreparedFileSyncTarget, ServiceName, StartedService } from "@lando/sdk/schema";
import type { EnvironmentValueResolver } from "@lando/sdk/services";
import {
  type AppPlanner,
  type ApplyResult,
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
import type { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { DateTime, Effect, Option } from "effect";
import { resolveProxyDefaultDomain } from "../config/proxy-default-domain.ts";
import { resolveRouterConfigForApp, routerEnabled } from "../config/router-config.ts";
import type { ResolvedAppTarget } from "../landofile/app-resolution.ts";
import { applyActivation, openDatabaseCredentialSession } from "../lifecycle/activation-apply.ts";
import { mapFailureErrors } from "../lifecycle/failure-compensation.ts";
import { type PreparedRouteUrls, prepareRouteUrlBindings } from "../lifecycle/route-url-bindings.ts";
import { type PreparedCertificates, prepareServiceCertificates } from "../lifecycle/service-certificates.ts";
import { completeStartup } from "../lifecycle/startup-completion.ts";
import { verifyActiveVolumeCoordination } from "../lifecycle/volume-coordination.ts";
import type { PreparedRuntimeProvider } from "../providers/prepared.ts";
import { withBuildProvider } from "../services/build-orchestrator.ts";
import { readPendingAcceleratedStart } from "./accelerated-start-journal.ts";
import { verifyPendingStartResume } from "./accelerated-start-resume.ts";
import type { AdmittedApp } from "./app-activation.ts";
import { applyAndObserveServices } from "./apply-observe.ts";
import { publishApplyOutcomeNotices } from "./apply-outcome-notices.ts";
import { collectPlanConnections, observeService, startedServices } from "./connection-collector.ts";
import { ensureGlobalServicesRunning, requiredGlobalServicesForPlan } from "./ensure-global-services.ts";
import { publishAndRunAppEvent, publishAndRunPostAppEvent } from "./events.ts";
import { hasExactFileSyncSessionCoverage } from "./file-sync.ts";
import {
  acquireFileSyncEngine,
  acquirePlannedFileSyncEngine,
  requireFileSyncProvider,
  validateDesiredFileSyncEngine,
} from "./file-sync-acquire.ts";
import { fileSyncBundle } from "./file-sync-bundle.ts";
import { resolveFileSyncMountPlan } from "./file-sync-plan.ts";
import { withGlobalConsumerAdmission } from "./global-consumer-admission.ts";
import { verifyGlobalConsumerAdmission } from "./global-consumer-lease.ts";
import { runPostStartScan, startupScanUrls } from "./post-start-scan.ts";
import { prepareAcceleratedStart } from "./prepare-accelerated-start.ts";
import { selectRebuildPlan } from "./service-selection.ts";
import { convergeRemovedServices } from "./start-convergence.ts";
import type { StartManagedScope } from "./start-file-sync.ts";
import { retireUnusedGpgAgentWorker } from "./start-gpg-agent.ts";
import { retireUnusedHostProxyWorker } from "./start-host-proxy.ts";
import { markStartMutation } from "./start-incomplete-notice.ts";
import { projectDebuggerOverlay, withAcquiredStartOverlays } from "./start-overlays.ts";
import { withApplyProgress, withGlobalStartProgress } from "./start-progress-phases.ts";
import { retireUnusedSshAgentWorker } from "./start-ssh-agent.ts";
import { publishStartWarnings } from "./start-warnings.ts";
import type { StopAppPreflight } from "./stop-internal.ts";

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
  services?: readonly ServiceName[],
) {
  const execution = services === undefined ? target.plan : yield* selectRebuildPlan(target.plan, services);
  const bundle = yield* fileSyncBundle(execution);
  yield* validateDesiredFileSyncEngine(execution);
  if (bundle.kind === "accelerated") {
    const registry = yield* RuntimeProviderRegistry;
    yield* requireFileSyncProvider(bundle, yield* registry.select(target.plan));
  }
  const preparedTargets = yield* verifyPendingStartResume(target.app, execution, services);
  if (preparedTargets !== null) return preparedTargets;
  if (services !== undefined && bundle.kind === "ordinary") return;
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

export const launchAdmittedApp = Effect.fnUntraced(function* (
  admitted: AdmittedApp,
  options: StartAppOptions | undefined,
  managed: StartManagedScope | undefined,
  execution: {
    readonly buildOptions?: BuildOptions;
    readonly forceAppBuild?: boolean;
    readonly preparedTargets?: readonly PreparedFileSyncTarget[];
    /** Start and restart announce replacements; rebuild recreates every container by design. */
    readonly announceApplyOutcome?: boolean;
  },
): Effect.fn.Return<StartAppResult, StartAppError, BoundStartAppServices> {
  const resolvedOptions = options ?? {};
  const { plan, certificates } = yield* preflightAppLaunch(admitted.target, admitted.provider);
  yield* announceAppLaunch({ target: admitted.target, plan, options: resolvedOptions });
  return yield* activateAppLaunch({
    admitted,
    plan,
    certificates,
    options: resolvedOptions,
    managed,
    execution,
  });
});

type DatabaseCredentialSession = Effect.Success<ReturnType<typeof openDatabaseCredentialSession>>;
type PendingAcceleratedStart = Effect.Success<ReturnType<typeof prepareAcceleratedStart>>["pendingStart"];

export const preflightAppLaunch = Effect.fnUntraced(function* (
  target: ResolvedAppTarget,
  provider: PreparedRuntimeProvider,
  services?: readonly ServiceName[],
) {
  const bundle = yield* fileSyncBundle(target.plan);
  const inspectAppliedFileSync = provider.inspectAppliedFileSync;
  const inspectPrior =
    inspectAppliedFileSync === undefined
      ? undefined
      : () =>
          inspectAppliedFileSync(target.plan).pipe(
            Effect.map((prior) => {
              if (services === undefined || prior.status !== "accelerated") return prior;
              if (prior.sessions.some((session) => services.includes(session.service))) return prior;
              return { status: "ordinary" as const };
            }),
          );
  const pending = yield* readPendingAcceleratedStart(target.app, target.plan, services);
  const resolvedPlan =
    pending !== null ? target.plan : yield* resolveFileSyncMountPlan(target.plan, inspectPrior);
  // Desired id capabilities before hooks/provider work (pending resumes keep journal identity).
  if (pending === null && bundle.kind === "accelerated") {
    yield* acquirePlannedFileSyncEngine(resolvedPlan);
  }
  if (
    bundle.kind === "accelerated" &&
    provider.prepareFileSyncTargets !== undefined &&
    provider.inspectAppliedFileSync === undefined
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
  if (bundle.kind === "accelerated" && provider.prepareFileSyncTargets === undefined)
    return yield* Effect.fail(
      new FileSyncStartError({
        engineId: bundle.id,
        message: "The provider cannot prepare the planned accelerated targets.",
        remediation: "Restore a provider with the recorded prepared-volume lifecycle before retrying start.",
      }),
    );
  // Prepare before hooks; the activation applier requires this proof to stamp the plan it applies.
  const prepared = yield* prepareServiceCertificates(resolvedPlan);
  if (bundle.kind === "accelerated" && inspectPrior !== undefined) {
    const prior = yield* inspectPrior();
    if (prior.status === "accelerated" && prior.engineId !== bundle.id) {
      return yield* Effect.fail(
        new FileSyncStartError({
          engineId: bundle.id,
          message: "The applied app used a different file sync engine.",
          remediation: "Restore the engine recorded in provider state before restarting this app.",
        }),
      );
    }
  }
  return prepared;
});

export const announceAppLaunch = Effect.fnUntraced(function* (input: {
  readonly target: ResolvedAppTarget;
  readonly plan: AppPlan;
  readonly options: StartAppOptions;
  readonly services?: readonly ServiceName[];
}) {
  const { target, plan, options, services } = input;
  const events = yield* EventService;
  const proxy = yield* RouterService;
  const ref = target.app;

  yield* publishStartWarnings(plan);
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
    ...(services === undefined ? {} : { services }),
    timestamp: now(),
  });
  yield* publishAndRunAppEvent(services === undefined ? plan : target.plan, "pre-start", preStart);

  const neededGlobalServices = requiredGlobalServicesForPlan(plan);
  if (
    routerEnabled(plan) &&
    plan.routes.length > 0 &&
    (plan.router?.id ?? proxy.id) === proxy.id &&
    proxy.prepare !== undefined
  ) {
    const defaultDomain = yield* resolveProxyDefaultDomain;
    const { router, routerPin } = yield* resolveRouterConfigForApp(target.landofile?.document.router);
    yield* proxy.prepare({ defaultDomain, router, routerPin });
  }
  if (neededGlobalServices.length > 0) {
    const ensureGlobals = ensureGlobalServicesRunning({
      services: neededGlobalServices,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }).pipe(
      mapFailureErrors((cause) =>
        cause instanceof ServiceNotReadyError || cause instanceof AppPlacementError
          ? cause
          : new GlobalAutoStartError({
              message: `Failed to auto-start global services (${neededGlobalServices.join(", ")}) required by ${plan.name}.`,
              app: plan.name,
              services: [...neededGlobalServices],
              remediation:
                causeRemediation(cause) ??
                "Lando tried to install and start the required global services automatically. Fix the underlying error, then retry `lando start`.",
              cause,
            }),
      ),
    );
    yield* withGlobalStartProgress({ events, plan, serviceIds: neededGlobalServices, work: ensureGlobals });
  }
});

/** Capture the apply result separately because the progress tree returns only per-service rows. */
const applyAppLaunch = Effect.fnUntraced(function* (input: {
  readonly routeUrls: PreparedRouteUrls | undefined;
  readonly admitted: AdmittedApp;
  readonly plan: AppPlan;
  readonly runtimePlan: AppPlan;
  readonly certificates: PreparedCertificates;
  readonly options: StartAppOptions;
  readonly environment: DatabaseCredentialSession;
  readonly pendingStart: PendingAcceleratedStart;
  readonly prepareGpgHome: Effect.Effect<void, GpgAgentTransportError>;
}) {
  const { admitted, plan, runtimePlan, certificates, options, environment, pendingStart } = input;
  const { target, provider, overlays } = admitted;
  const events = yield* EventService;
  const services = Object.values(runtimePlan.services);
  const registry = yield* RuntimeProviderRegistry;
  let applyOutcome: Effect.Success<ReturnType<typeof applyActivation>> | undefined;
  let initial: ReadonlyMap<string, ServiceRuntimeInfo> = new Map();
  let servicesRemoved: ReadonlyArray<string> = [];
  yield* withApplyProgress({
    events,
    plan,
    services,
    rows: (rows) => rows,
    work: Effect.gen(function* () {
      yield* verifyActiveVolumeCoordination(provider);
      const observations = yield* provider.list({
        app: runtimePlan.id,
        includeUnplanned: true,
      });
      // Whole-app start names every service, so containers of services the Landofile no
      // longer defines are pruned here, after accelerated-start preparation.
      servicesRemoved = yield* convergeRemovedServices(runtimePlan, provider, {
        receipts: (
          registry.resourceOwnership?.(runtimePlan.provider, runtimePlan.root) ?? Effect.succeed(undefined)
        ).pipe(Effect.map(adoptionReceiptsFromSummary)),
        app: target.app,
        events,
        observations,
        verifyAdmission: verifyGlobalConsumerAdmission,
      });
      if (pendingStart !== undefined) yield* pendingStart.advance("record-apply-intent");
      const observed = yield* applyAndObserveServices({
        apply: applyActivation({
          provider,
          plan: runtimePlan,
          previousPlan: admitted.placement.plan,
          certificates,
          routeUrls: input.routeUrls,
          reconcile: options.reconcile ?? false,
          complete: true,
          ...(environment === undefined ? {} : { environment }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          beforeApply: verifyGlobalConsumerAdmission,
        }),
        ...(pendingStart === undefined ? {} : { afterApply: pendingStart.complete }),
        prepareGpgHome: input.prepareGpgHome,
        beforeInspect: Effect.gen(function* () {
          // Retire only after the apply replaced the previous realization, so a failed start
          // keeps every worker the still-running app may still use.
          yield* retireUnusedSshAgentWorker(plan, target.app);
          yield* retireUnusedGpgAgentWorker(plan, target.app, overlays.gpgIntent);
          yield* retireUnusedHostProxyWorker(plan, target.app, provider.capabilities, "retire");
        }),
        provider,
        plan: runtimePlan,
        services,
      });
      applyOutcome = observed.applied;
      initial = observed.initial;
      return observed.inspected.map((runtime) => observeService(runtimePlan, runtime));
    }),
  });
  return { applyOutcome, initial, servicesRemoved };
});

/**
 * Keep completion inside the activation scopes so the credential session and admission lease
 * stay open until readiness and its checks are done.
 */
const completeAppLaunch = Effect.fnUntraced(function* (input: {
  readonly admitted: AdmittedApp;
  readonly plan: AppPlan;
  readonly runtimePlan: AppPlan;
  readonly options: StartAppOptions;
  readonly initial: ReadonlyMap<string, ServiceRuntimeInfo>;
  readonly applyOutcome: ApplyResult | undefined;
  readonly routeUrls: PreparedRouteUrls | undefined;
  readonly forceAppBuild?: boolean;
}) {
  const { admitted, plan, runtimePlan, options, initial, applyOutcome } = input;
  const { target, provider } = admitted;
  const events = yield* EventService;
  const builds = yield* BuildOrchestrator;
  const proxy = yield* RouterService;
  const services = Object.values(runtimePlan.services);
  const ready = yield* completeStartup({
    policy: "user-start",
    routeUrls: input.routeUrls,
    builds,
    router: proxy,
    events,
    ...(target.landofile?.document.router === undefined
      ? {}
      : { landofileRouter: target.landofile.document.router }),
    ...(input.forceAppBuild === undefined ? {} : { forceAppBuild: input.forceAppBuild }),
    provider,
    plan: runtimePlan,
    services: services.map((service) => service.name),
    initial,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const servicesStarted = startedServices(
    yield* collectPlanConnections(runtimePlan, ready),
    applyOutcome?.services,
  );

  yield* publishAppLaunchComplete({ target, plan });
  const checks = yield* scanAppLaunch(runtimePlan, provider, servicesStarted);
  return { servicesStarted, checks };
});

export const publishAppLaunchComplete = Effect.fnUntraced(function* (input: {
  readonly target: ResolvedAppTarget;
  readonly plan: AppPlan;
  readonly services?: readonly ServiceName[];
}) {
  const { target, plan, services } = input;
  const events = yield* EventService;
  yield* events.publish(
    PostAppStartEvent.make({
      eventName: "post-app-start",
      appRef: target.app,
      providerId: plan.provider,
      timestamp: now(),
    }),
  );
  yield* publishAndRunPostAppEvent(
    services === undefined ? plan : target.plan,
    "post-start",
    PostStartEvent.make({
      _tag: "post-start",
      scope: "app",
      app: target.app,
      plan,
      timestamp: now(),
      ...(services === undefined ? {} : { services }),
    }),
  );
});

export const scanAppLaunch = Effect.fnUntraced(function* (
  plan: AppPlan,
  provider: PreparedRuntimeProvider,
  services: readonly StartedService[],
) {
  const scanner = yield* Effect.serviceOption(UrlScanner);
  if (Option.isNone(scanner)) return undefined;
  const events = yield* EventService;
  return yield* runPostStartScan({
    scanner: scanner.value,
    plan,
    events,
    urls: startupScanUrls(plan, services),
    observeListener: (service) =>
      observeTcpListener(service, (command) =>
        provider.execStream({ app: plan.id, service: service.name, plan }, command),
      ),
  });
});

const activateAppLaunch = Effect.fnUntraced(function* (input: {
  readonly admitted: AdmittedApp;
  readonly plan: AppPlan;
  readonly certificates: PreparedCertificates;
  readonly options: StartAppOptions;
  readonly managed: StartManagedScope | undefined;
  readonly execution: {
    readonly buildOptions?: BuildOptions;
    readonly forceAppBuild?: boolean;
    readonly preparedTargets?: readonly PreparedFileSyncTarget[];
    readonly announceApplyOutcome?: boolean;
  };
}) {
  const { admitted, plan, certificates, options, managed, execution } = input;
  const { target, provider, overlays } = admitted;
  const events = yield* EventService;
  const builds = yield* BuildOrchestrator;

  yield* markStartMutation(target.plan);
  return yield* withAcquiredStartOverlays({ ...target, plan }, overlays, {
    provider,
    workerPlan: plan,
    reusePolicy: "exact",
    ...(managed === undefined ? {} : { managed }),
    use: Effect.fnUntraced(function* (applyPlan, prepareGpgHome) {
      const builtPlan = yield* withBuildProvider(builds.build(applyPlan, execution.buildOptions), provider);
      const runtimePlan = projectDebuggerOverlay(builtPlan, overlays);
      return yield* withGlobalConsumerAdmission(
        {
          plan: builtPlan,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          ...(target.landofile?.document.router === undefined
            ? {}
            : { landofileRouter: target.landofile.document.router }),
        },
        Effect.scoped(
          Effect.gen(function* () {
            const environment = yield* openDatabaseCredentialSession(runtimePlan);
            const { pendingStart } = yield* prepareAcceleratedStart(builtPlan, provider, {
              app: target.app,
              events,
              managed,
              ...(execution.preparedTargets === undefined
                ? {}
                : { preparedTargets: execution.preparedTargets }),
            });
            if (pendingStart !== undefined) yield* pendingStart.advance("record-sessions");
            const routeUrls = yield* prepareRouteUrlBindings({
              plan: runtimePlan,
              routes: runtimePlan.routes,
              router: yield* RouterService,
            });
            const launch = yield* applyAppLaunch({
              routeUrls,
              admitted,
              plan,
              runtimePlan,
              certificates,
              options,
              environment,
              pendingStart,
              prepareGpgHome,
            });
            if (execution.announceApplyOutcome === true)
              yield* publishApplyOutcomeNotices(events, launch.applyOutcome?.services, { created: false });
            const completed = yield* completeAppLaunch({
              routeUrls,
              admitted,
              plan,
              runtimePlan,
              options,
              initial: launch.initial,
              applyOutcome: launch.applyOutcome,
              ...(execution.forceAppBuild === undefined ? {} : { forceAppBuild: execution.forceAppBuild }),
            });
            return {
              app: plan.name,
              servicesStarted: completed.servicesStarted,
              servicesRemoved: launch.servicesRemoved,
              ...(launch.applyOutcome?.credentialChanges === undefined
                ? {}
                : { credentialChanges: launch.applyOutcome.credentialChanges }),
              ...(completed.checks === undefined ? {} : { checks: completed.checks }),
            };
          }),
        ),
      );
    }),
  });
});
