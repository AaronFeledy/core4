import { Cause, DateTime, Effect, Exit, Option, Ref, Schema } from "effect";

import type { StartAppError as SdkStartAppError, StartAppOptions, StartAppResult } from "@lando/sdk/app";
import {
  type ComposeKeyRejectedError,
  FileSyncStartError,
  GlobalAutoStartError,
  type LandofileLoadExpressionError,
  type ProxyError,
} from "@lando/sdk/errors";
import {
  MessageWarnEvent,
  PostAppStartEvent,
  PostStartEvent,
  PreAppStartEvent,
  PreStartEvent,
} from "@lando/sdk/events";
import { ServiceName } from "@lando/sdk/schema";
import {
  type AppPlanner,
  BuildOrchestrator,
  EventService,
  FileSyncEngine,
  type FileSystem,
  type GlobalAppService,
  type LandofileService,
  ManagedFileTransactionGuard,
  type PathsService,
  type PluginRegistry,
  type ProviderError,
  RouterService,
  RuntimeProviderRegistry,
  type ShellRunner,
  type StateStore,
  UrlScanner,
} from "@lando/sdk/services";

import type { RedactionService } from "@lando/redaction/service";
import type { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { resolveProxyDefaultDomain } from "../config/proxy-default-domain.ts";
import { resolveRouterConfigForApp } from "../config/router-config.ts";
import type { ResolvedAppTarget } from "../landofile/app-resolution.ts";
import {
  publishedTargetsFromEndpoints,
  rewriteCrossEngineProxyRoutes,
} from "../lifecycle/cross-engine-routes.ts";
import { compensateFailure, runAllAndMergeFailures } from "../lifecycle/failure-compensation.ts";
import { appliedProxyUrlsByService } from "../lifecycle/route-urls.ts";
import { applyAppRoutes, removeRoutesAndDestroyApp, teardownAppliedApp } from "../lifecycle/routes.ts";
import { verifyActiveVolumeCoordination } from "../lifecycle/volume-coordination.ts";
import { recordCreatedVolumes } from "../lifecycle/volume-initialization.ts";
import { taggedErrorRemediation } from "../providers/managed.ts";
import { withBuildProvider } from "../services/build-orchestrator.ts";
import { resolveServiceEnvironmentSecrets } from "../services/secret-environment.ts";
import { beginAcceleratedStart, requireNoPendingAcceleratedStart } from "./accelerated-start-journal.ts";
import { publishedEndpointUrl } from "./authority-url.ts";
import { ensureGlobalServicesRunning, requiredGlobalServicesForPlan } from "./ensure-global-services.ts";
import { runAppEvent, runPostAppEvent } from "./events.ts";
import {
  guardOrdinaryFileSyncFallback,
  resolveFileSyncMountPlan,
  withOrdinaryMounts,
} from "./file-sync-plan.ts";
import { hasExactFileSyncSessionCoverage } from "./file-sync.ts";
import { runPostStartScan, startupScanUrls } from "./post-start-scan.ts";
import { verifyPreparedFileSyncTargets } from "./prepared-file-sync-targets.ts";
import {
  type PreparedFileSyncSessions,
  type StartManagedScope,
  startFileSyncSessions,
} from "./start-file-sync.ts";
import { resolveStartGpgAgentIntent } from "./start-gpg-agent-intent.ts";
import { withStartedGpgAgent } from "./start-gpg-agent.ts";
import { withStartedHostProxy } from "./start-host-proxy.ts";
import { resolveStartSshAgentIntent } from "./start-ssh-agent-intent.ts";
import { withStartedSshAgent } from "./start-ssh-agent.ts";
import type { StopAppPreflight } from "./stop-internal.ts";

import {
  withApplyProgress,
  withGlobalStartProgress,
  withRoutesStartProgress,
} from "./start-progress-phases.ts";

export type StartAppError = SdkStartAppError | ComposeKeyRejectedError | LandofileLoadExpressionError;
export type { StartAppOptions, StartAppResult } from "@lando/sdk/app";
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

const now = () => DateTime.unsafeMake(new Date().toISOString());

/** Private preflight shared by start, restart, and rebuild before any app hook or provider action. */
export const ensureStartTransactionConsistent = (target: ResolvedAppTarget) =>
  ManagedFileTransactionGuard.pipe(Effect.flatMap((guard) => guard.ensureConsistent(String(target.root))));

/** Verify saved accelerated ownership and clear a prior drain before init hooks can write. */
export const preflightStartAppDrain = (target: ResolvedAppTarget, stopPreflight?: StopAppPreflight) =>
  Effect.gen(function* () {
    yield* requireNoPendingAcceleratedStart(target.app, target.plan);
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
          engineId: target.plan.fileSync[0]?.engineId ?? "unavailable",
          message: "Previous file sync state could not be verified before app init hooks.",
          remediation: "Inspect and repair the provider's applied file sync state, then retry start.",
        }),
      );
    }
    if (prior.status !== "accelerated") return;
    const maybeFileSync = stopPreflight?.maybeFileSync ?? (yield* Effect.serviceOption(FileSyncEngine));
    if (
      Option.isNone(maybeFileSync) ||
      maybeFileSync.value.id !== prior.engineId ||
      !(yield* maybeFileSync.value.isAvailable.pipe(Effect.catchAll(() => Effect.succeed(false))))
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
    const sessions =
      stopPreflight?.sessions ?? (yield* maybeFileSync.value.listSessions({ app: target.app }));
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

/** Stop has just drained durable sessions; clear that drain before startup resumes them. */
export const invalidateAppDrainAfterStop = (target: ResolvedAppTarget, stopPreflight: StopAppPreflight) => {
  if (stopPreflight.appliedFileSync.status !== "accelerated") return Effect.void;
  const engine = stopPreflight.maybeFileSync;
  return Option.isSome(engine) && engine.value.appLifecycle !== undefined
    ? engine.value.appLifecycle.invalidateDrain(target.app)
    : Effect.void;
};

export const startAppForTargetUnlocked = (
  options: StartAppOptions | undefined,
  target: ResolvedAppTarget,
  managed?: StartManagedScope,
  execution: { readonly forceAppBuild?: boolean } = {},
): Effect.Effect<StartAppResult, SdkStartAppError, BoundStartAppServices> =>
  Effect.gen(function* () {
    const resolvedOptions = options ?? {};
    const registry = yield* RuntimeProviderRegistry;
    const events = yield* EventService;
    const builds = yield* BuildOrchestrator;
    const proxy = yield* RouterService;

    const candidateProvider = yield* registry.select(target.plan);
    const inspectAppliedFileSync = candidateProvider.inspectAppliedFileSync;
    const inspectPrior =
      inspectAppliedFileSync === undefined ? undefined : () => inspectAppliedFileSync(target.plan);
    const resolvedPlan = yield* resolveFileSyncMountPlan(target.plan, inspectPrior);
    const selectedProvider =
      resolvedPlan === target.plan ? candidateProvider : yield* registry.select(resolvedPlan);
    if (
      resolvedPlan.fileSync.length > 0 &&
      selectedProvider.prepareFileSyncTargets !== undefined &&
      selectedProvider.inspectAppliedFileSync === undefined
    ) {
      return yield* Effect.fail(
        new FileSyncStartError({
          engineId: resolvedPlan.fileSync[0]?.engineId ?? "unknown",
          message: "The selected provider cannot verify previous accelerated mount state.",
          remediation:
            "Use a provider that implements both accelerated target preparation and prior-state inspection.",
        }),
      );
    }
    const needsProviderFallback =
      resolvedPlan.fileSync.length > 0 && selectedProvider.prepareFileSyncTargets === undefined;
    if (needsProviderFallback) yield* guardOrdinaryFileSyncFallback(target.plan, inspectPrior);
    const plan = needsProviderFallback ? withOrdinaryMounts(resolvedPlan) : resolvedPlan;
    if (plan !== target.plan) {
      yield* events.publish(
        MessageWarnEvent.make({
          body: "Accelerated file sync is unavailable. Lando is using ordinary bind mounts for this app.",
          timestamp: now(),
        }),
      );
    }
    const provider = plan === resolvedPlan ? selectedProvider : yield* registry.select(plan);
    if (plan.fileSync.length > 0 && inspectPrior !== undefined) {
      const prior = yield* inspectPrior();
      if (prior.status === "accelerated" && prior.engineId !== plan.fileSync[0]?.engineId) {
        return yield* Effect.fail(
          new FileSyncStartError({
            engineId: plan.fileSync[0]?.engineId ?? "unknown",
            message: "The applied app used a different file sync engine.",
            remediation: "Restore the engine recorded in provider state before restarting this app.",
          }),
        );
      }
    }
    const ref = target.app;
    const applyStarted = yield* Ref.make(false);
    const routesApplied = yield* Ref.make(false);
    const routesAttempted = yield* Ref.make(false);
    const routesRemoved = yield* Ref.make(false);
    const writersStopped = yield* Ref.make(false);
    const leaseCleanupDone = yield* Ref.make(false);

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
    yield* events.publish(preStart);
    yield* runAppEvent(plan, "pre-start", preStart);

    const neededGlobalServices = requiredGlobalServicesForPlan(plan);
    if (plan.routes.length > 0 && neededGlobalServices.includes(proxy.id) && proxy.prepare !== undefined) {
      const defaultDomain = yield* resolveProxyDefaultDomain;
      const { router, routerPin } = yield* resolveRouterConfigForApp(target.landofile?.router);
      yield* proxy.prepare({ defaultDomain, router, routerPin });
    }
    if (neededGlobalServices.length > 0) {
      const ensureGlobals = ensureGlobalServicesRunning({
        services: neededGlobalServices,
        ...(resolvedOptions.signal === undefined ? {} : { signal: resolvedOptions.signal }),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new GlobalAutoStartError({
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
              ...(managed === undefined ? {} : { managed }),
              use: (applyPlan) =>
                Effect.gen(function* () {
                  const builtPlan = yield* withBuildProvider(builds.build(applyPlan), provider);
                  const serviceEnvironment = yield* resolveServiceEnvironmentSecrets(builtPlan);
                  const serviceList = Object.values(builtPlan.services);
                  const prepareFileSyncTargets = provider.prepareFileSyncTargets;
                  if (plan.fileSync.length > 0 && prepareFileSyncTargets === undefined) {
                    return yield* Effect.fail(
                      new FileSyncStartError({
                        engineId: plan.fileSync[0]?.engineId ?? "unknown",
                        message:
                          "The selected provider cannot prepare accelerated mount targets before app startup.",
                        remediation:
                          "Use ordinary bind mounts or select a provider with accelerated mount target support.",
                      }),
                    );
                  }
                  const pendingStart =
                    plan.fileSync.length > 0 ? yield* beginAcceleratedStart(builtPlan, ref) : undefined;
                  let preparedRollback: Effect.Effect<void, ProviderError> | undefined;
                  let sessionLease: PreparedFileSyncSessions | undefined;
                  if (plan.fileSync.length > 0) {
                    const selectedPrepare = prepareFileSyncTargets as NonNullable<
                      typeof prepareFileSyncTargets
                    >;
                    const prepared = yield* selectedPrepare(builtPlan);
                    preparedRollback = prepared.rollback;
                    const coverage = yield* Effect.exit(
                      verifyPreparedFileSyncTargets(builtPlan, prepared.targets),
                    );
                    if (Exit.isFailure(coverage)) {
                      const rollback = yield* Effect.exit(prepared.rollback);
                      if (Exit.isFailure(rollback)) {
                        return yield* Effect.failCause(Cause.sequential(coverage.cause, rollback.cause));
                      }
                      if (pendingStart !== undefined) yield* pendingStart.clear;
                      return yield* Effect.failCause(coverage.cause);
                    }
                    sessionLease = yield* Effect.uninterruptibleMask((restore) =>
                      Effect.gen(function* () {
                        const selectedEngine = yield* Effect.serviceOption(FileSyncEngine);
                        const bindPreparedTargets =
                          selectedEngine._tag === "Some"
                            ? selectedEngine.value.bindPreparedTargets
                            : undefined;
                        const bindingExit =
                          bindPreparedTargets === undefined
                            ? Exit.succeed(undefined)
                            : yield* Effect.exit(restore(bindPreparedTargets(builtPlan, prepared.targets)));
                        if (Exit.isFailure(bindingExit)) {
                          const rollbackExit = yield* Effect.exit(prepared.rollback);
                          if (Exit.isFailure(rollbackExit)) {
                            return yield* Effect.failCause(
                              Cause.sequential(bindingExit.cause, rollbackExit.cause),
                            );
                          }
                          if (pendingStart !== undefined) yield* pendingStart.clear;
                          return yield* Effect.failCause(bindingExit.cause);
                        }

                        const boundEngine = bindingExit.value;
                        // No session mutation has occurred yet. The reconciler revokes
                        // this permission before reusing or mutating a session.
                        const safeToRollbackTargets = yield* Ref.make(true);
                        const syncExit = yield* Effect.exit(
                          restore(
                            startFileSyncSessions(
                              builtPlan,
                              events,
                              managed,
                              safeToRollbackTargets,
                              boundEngine,
                            ),
                          ),
                        );
                        if (Exit.isSuccess(syncExit)) return syncExit.value;

                        const safe = yield* Ref.get(safeToRollbackTargets);
                        const app = builtPlan.fileSync[0]?.session.app;
                        const engine =
                          boundEngine ?? (selectedEngine._tag === "Some" ? selectedEngine.value : undefined);
                        const noOwnedSessions =
                          safe && app !== undefined && engine !== undefined
                            ? yield* Effect.exit(engine.listSessions({ app })).pipe(
                                Effect.map(
                                  (listExit) => Exit.isSuccess(listExit) && listExit.value.length === 0,
                                ),
                              )
                            : false;
                        if (!noOwnedSessions) return yield* Effect.failCause(syncExit.cause);
                        const rollbackExit = yield* Effect.exit(prepared.rollback);
                        if (Exit.isFailure(rollbackExit)) {
                          return yield* Effect.failCause(
                            Cause.sequential(syncExit.cause, rollbackExit.cause),
                          );
                        }
                        if (pendingStart !== undefined) yield* pendingStart.clear;
                        return yield* Effect.failCause(syncExit.cause);
                      }),
                    );
                  }

                  const teardownForFailure = teardownAppliedApp(provider, plan).pipe(
                    Effect.tap(() => Ref.set(writersStopped, true)),
                  );
                  const removeRoutesForFailure = proxy
                    .removeRoutes(plan.id)
                    .pipe(Effect.tap(() => Ref.set(routesRemoved, true)));
                  const removeRoutesAndTeardown =
                    sessionLease === undefined
                      ? removeRoutesAndDestroyApp(proxy, provider, plan)
                      : runAllAndMergeFailures<ProviderError | ProxyError, never>([
                          removeRoutesForFailure,
                          teardownForFailure,
                        ]);
                  const finishStart = Effect.gen(function* () {
                    if (pendingStart !== undefined) yield* pendingStart.phase("sessions-ready");
                    const applyAndInspect = Effect.gen(function* () {
                      yield* verifyActiveVolumeCoordination(provider);
                      if (pendingStart !== undefined) yield* pendingStart.phase("apply-intent");
                      yield* Ref.set(applyStarted, true);
                      yield* Effect.scoped(
                        provider
                          .apply(builtPlan, {
                            reconcile: resolvedOptions.reconcile ?? false,
                            serviceEnvironment,
                            ...(resolvedOptions.signal === undefined
                              ? {}
                              : { signal: resolvedOptions.signal }),
                          })
                          .pipe(Effect.tap((result) => recordCreatedVolumes(provider, builtPlan, result))),
                      );
                      yield* prepareGpgHome;
                      return yield* Effect.forEach(serviceList, (service) =>
                        provider.inspect({ app: plan.id, service: service.name }).pipe(
                          Effect.map((runtime) => {
                            const sourceEndpoints = runtime.endpoints ?? service.endpoints;
                            return {
                              name: String(service.name),
                              state: runtime.state ?? runtime.status,
                              endpoints: sourceEndpoints.flatMap((endpoint) => {
                                if (endpoint._tag === "internal") return [];
                                const rendered = publishedEndpointUrl(endpoint);
                                return rendered === undefined ? [] : [rendered];
                              }),
                              published: publishedTargetsFromEndpoints(String(service.name), sourceEndpoints),
                            };
                          }),
                        ),
                      );
                    });
                    const inspectedServices = yield* compensateFailure(
                      withApplyProgress({ events, plan, services: serviceList, work: applyAndInspect }),
                      sessionLease === undefined ? teardownAppliedApp(provider, plan) : teardownForFailure,
                    );

                    yield* compensateFailure(
                      withBuildProvider(
                        builds.buildApp(builtPlan, {
                          ...(execution.forceAppBuild === true ? { force: true } : {}),
                          ...(resolvedOptions.signal === undefined ? {} : { signal: resolvedOptions.signal }),
                        }),
                        provider,
                      ),
                      removeRoutesAndTeardown,
                    );

                    const routedPlan = {
                      ...builtPlan,
                      routes: rewriteCrossEngineProxyRoutes({
                        plan: builtPlan,
                        published: inspectedServices.flatMap((service) => service.published),
                      }),
                    };
                    const applyRoutes = applyAppRoutes(proxy, routedPlan, target.landofile?.router);
                    yield* Ref.set(routesAttempted, true);
                    const proxyResult = yield* compensateFailure(
                      routedPlan.routes.length === 0
                        ? applyRoutes
                        : withRoutesStartProgress({ events, plan, work: applyRoutes }),
                      removeRoutesAndTeardown,
                    );
                    yield* Ref.set(routesApplied, true);
                    const proxyUrls = appliedProxyUrlsByService(proxyResult);
                    const servicesStarted = inspectedServices.map((service) => ({
                      ...service,
                      endpoints: [
                        ...(proxyUrls.get(ServiceName.make(service.name)) ?? []),
                        ...service.endpoints,
                      ],
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
                      removeRoutesAndTeardown,
                    );
                    const postStart = PostStartEvent.make({
                      _tag: "post-start",
                      scope: "app",
                      app: ref,
                      plan,
                      timestamp: now(),
                    });
                    yield* events.publish(postStart);
                    yield* runPostAppEvent(plan, "post-start", postStart);
                    const scanner = yield* Effect.serviceOption(UrlScanner);
                    if (Option.isSome(scanner)) {
                      yield* runPostStartScan({
                        scanner: scanner.value,
                        plan: builtPlan,
                        events,
                        urls: startupScanUrls(builtPlan, servicesStarted),
                      });
                    }
                    if (pendingStart !== undefined) yield* pendingStart.clear;

                    return { app: plan.name, servicesStarted };
                  });
                  if (sessionLease === undefined) return yield* finishStart;
                  return yield* Effect.uninterruptibleMask((restore) =>
                    Effect.gen(function* () {
                      const exit = yield* Effect.exit(restore(finishStart));
                      if (Exit.isSuccess(exit)) return exit.value;
                      const cleanupExit = yield* Effect.exit(
                        Effect.gen(function* () {
                          const needRoutes =
                            (yield* Ref.get(routesAttempted)) && !(yield* Ref.get(routesRemoved));
                          const needWriters =
                            (yield* Ref.get(applyStarted)) && !(yield* Ref.get(writersStopped));
                          yield* runAllAndMergeFailures<ProviderError | ProxyError, never>([
                            ...(needRoutes ? [removeRoutesForFailure] : []),
                            ...(needWriters ? [teardownForFailure] : []),
                          ]);
                          yield* sessionLease.rollback;
                          if (sessionLease.rollbackTargets && preparedRollback !== undefined)
                            yield* preparedRollback;
                          yield* Ref.set(leaseCleanupDone, true);
                          if (sessionLease.rollbackTargets && pendingStart !== undefined)
                            yield* pendingStart.clear;
                        }),
                      );
                      if (Exit.isFailure(cleanupExit)) {
                        return yield* Effect.failCause(Cause.parallel(exit.cause, cleanupExit.cause));
                      }
                      return yield* Effect.failCause(exit.cause);
                    }),
                  );
                }),
            }),
        }),
    }).pipe(
      Effect.onInterrupt(() =>
        Effect.all([Ref.get(applyStarted), Ref.get(routesApplied), Ref.get(leaseCleanupDone)]).pipe(
          Effect.flatMap(([started, routed, cleaned]) => {
            if (cleaned) return Effect.void;
            if (started || routed) return removeRoutesAndDestroyApp(proxy, provider, plan);
            return Effect.void;
          }),
          Effect.orDie,
        ),
      ),
    );
  });
