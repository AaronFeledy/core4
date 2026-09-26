import { DateTime, Effect, Schema } from "effect";

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
  AppPlanner,
  BuildOrchestrator,
  EventService,
  LandofileService,
  RouterService,
  RuntimeProviderRegistry,
  StateStore,
} from "@lando/sdk/services";

import type { RedactionService } from "@lando/redaction/service";
import { PostRebuildEvent, PreRebuildEvent } from "@lando/sdk/events";
import { type AppPlan, type AppRef, ServiceName } from "@lando/sdk/schema";
import type { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { type ResolvedAppTarget, loadUserLandofile, userAppRef } from "../landofile/app-resolution.ts";
import { compensateFailure, compensateFailureUnless } from "../lifecycle/failure-compensation.ts";
import { routeUrlsForPlan } from "../lifecycle/routes.ts";
import { withPlanVolumeCoordination } from "../lifecycle/volume-coordination.ts";
import { recordCreatedVolumes } from "../lifecycle/volume-initialization.ts";
import { resolveMysqlVolumeTarget } from "../planner/mysql-volume.ts";
import { withBuildProvider } from "../services/build-orchestrator.ts";
import { resolveServiceEnvironmentSecrets } from "../services/secret-environment.ts";
import { isPostStartStepError } from "../tooling/event-errors.ts";
import { requireNoPendingAcceleratedStart } from "./accelerated-start-journal.ts";
import { appLockTarget, withAppMutationLock } from "./app-mutation-lock.ts";
import { publishedEndpointUrl } from "./authority-url.ts";
import { runAppEvent, runAppInitEvents } from "./events.ts";
import { selectRebuildPlan } from "./service-selection.ts";
import { resolveStartGpgAgentIntent } from "./start-gpg-agent-intent.ts";
import { withStartedGpgAgent } from "./start-gpg-agent.ts";
import { ensureStartTransactionConsistent, preflightStartAppDrain } from "./start-internal.ts";
import { resolveStartSshAgentIntent } from "./start-ssh-agent-intent.ts";
import { withStartedSshAgent } from "./start-ssh-agent.ts";
import { type StartManagedScope, StartedServiceResultSchema, startApp } from "./start.ts";
import { preflightStopApp } from "./stop-internal.ts";
import { stopAppWithPlan } from "./stop.ts";

export type RebuildAppError = SdkRebuildAppError | ComposeKeyRejectedError | LandofileLoadExpressionError;
export type { RebuildAppOptions, RebuildAppResult } from "@lando/sdk/app";

export const RebuildAppResultSchema = Schema.Struct({
  app: Schema.String,
  servicesRebuilt: Schema.Array(Schema.String),
  servicesStarted: Schema.Array(StartedServiceResultSchema),
});

type RebuildAppServices =
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

const rebuildSelectedServices = (
  plan: AppPlan,
  target: ResolvedAppTarget,
  options: Pick<RebuildAppOptions, "signal"> & { readonly managed?: StartManagedScope },
): Effect.Effect<
  RebuildAppResult["servicesStarted"],
  RebuildAppError,
  | BuildOrchestrator
  | RouterService
  | RuntimeProviderRegistry
  | EventService
  | PathsService
  | PrivateFileAccessService
> =>
  Effect.gen(function* () {
    const { signal, managed } = options;
    const registry = yield* RuntimeProviderRegistry;
    const builds = yield* BuildOrchestrator;
    const proxy = yield* RouterService;
    const provider = yield* registry.select(plan);
    const services = Object.values(plan.services);

    const stopSelected = Effect.forEach(
      [...services].reverse(),
      (service) =>
        provider
          .stop({ app: plan.id, service: service.name, plan })
          .pipe(Effect.catchTag("ServiceNotFoundError", () => Effect.void)),
      { discard: true },
    );
    yield* stopSelected;
    const builtPlan = yield* withBuildProvider(builds.build(plan), provider);
    const serviceEnvironment = yield* resolveServiceEnvironmentSecrets(builtPlan);
    const gpgIntent = yield* resolveStartGpgAgentIntent({ ...target, plan: builtPlan });
    const intent = yield* resolveStartSshAgentIntent({ ...target, plan: builtPlan });
    yield* withStartedGpgAgent(builtPlan, target.app, provider.capabilities, gpgIntent, {
      exec: provider.exec,
      ...(managed === undefined ? {} : { managed }),
      use: (gpgPlan, prepareGpgHome) =>
        withStartedSshAgent(gpgPlan, target.app, provider.capabilities, intent, {
          platform: provider.platform,
          ...(managed === undefined ? {} : { managed }),
          use: (applyPlan) =>
            Effect.scoped(
              provider
                .apply(applyPlan, {
                  reconcile: true,
                  recordedPlan: {
                    ...target.plan,
                    services: { ...target.plan.services, ...builtPlan.services },
                  },
                  ...(signal === undefined ? {} : { signal }),
                  serviceEnvironment,
                })
                .pipe(Effect.tap((result) => recordCreatedVolumes(provider, applyPlan, result))),
            ).pipe(Effect.zipRight(compensateFailure(prepareGpgHome, stopSelected))),
        }),
    });
    yield* withBuildProvider(
      builds.buildApp(builtPlan, { force: true, ...(signal === undefined ? {} : { signal }) }),
      provider,
    );

    const routedUrls = yield* routeUrlsForPlan(proxy, builtPlan);
    return yield* Effect.forEach(Object.values(builtPlan.services), (service) =>
      provider.inspect({ app: builtPlan.id, service: service.name, plan: builtPlan }).pipe(
        Effect.map((runtime) => ({
          name: String(service.name),
          state: runtime.state ?? runtime.status,
          endpoints: [
            ...(routedUrls.get(ServiceName.make(String(service.name))) ?? []),
            ...(runtime.endpoints ?? service.endpoints).flatMap((endpoint) => {
              if (endpoint._tag === "internal") return [];
              const rendered = publishedEndpointUrl(endpoint);
              return rendered === undefined ? [] : [rendered];
            }),
          ],
        })),
      ),
    );
  });

export const rebuildApp = (
  options: RebuildAppOptions = {},
  target?: ResolvedAppTarget,
  managed?: StartManagedScope,
): Effect.Effect<RebuildAppResult, RebuildAppError, RebuildAppServices> =>
  Effect.gen(function* () {
    const plannedTarget =
      target ??
      (yield* Effect.gen(function* () {
        const landofileService = yield* LandofileService;
        const registry = yield* RuntimeProviderRegistry;
        const planner = yield* AppPlanner;
        const landofile = yield* loadUserLandofile(landofileService);
        const capabilities = yield* registry.capabilities;
        const plan = yield* planner.plan(landofile, capabilities);
        return { plan, root: plan.root, app: userAppRef(plan), landofile } satisfies ResolvedAppTarget;
      }));
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
        body: () =>
          Effect.gen(function* () {
            yield* requireNoPendingAcceleratedStart(resolvedTarget.app, plan);
            const stopPreflight = yield* preflightStopApp(resolvedTarget);
            yield* preflightStartAppDrain(resolvedTarget, stopPreflight);
            yield* ensureStartTransactionConsistent(resolvedTarget);
            yield* runAppInitEvents(plan);
            const proxy = yield* RouterService;
            const events = yield* EventService;
            const ref: AppRef = resolvedTarget.app;
            const timestamp = () => DateTime.unsafeMake(new Date().toISOString());
            const preRebuild = PreRebuildEvent.make({
              _tag: "pre-rebuild",
              app: ref,
              timestamp: timestamp(),
            });
            yield* events.publish(preRebuild);
            yield* runAppEvent(plan, "pre-rebuild", preRebuild);
            const start = scoped
              ? {
                  app: plan.name,
                  servicesStarted: yield* rebuildSelectedServices(selectedPlan, resolvedTarget, {
                    ...options,
                    ...(managed === undefined ? {} : { managed }),
                  }),
                }
              : yield* Effect.gen(function* () {
                  yield* stopAppWithPlan({}, resolvedTarget, { skipInitEvents: true });
                  yield* managed?.onStopped ?? Effect.void;
                  return yield* compensateFailureUnless(
                    startApp(
                      {
                        reconcile: true,
                        ...(options.signal === undefined ? {} : { signal: options.signal }),
                      },
                      resolvedTarget,
                      managed,
                      { forceAppBuild: true, skipInitEvents: true, transactionPreflightDone: true },
                    ),
                    proxy.removeRoutes(plan.id),
                    isPostStartStepError,
                  );
                });
            const postRebuild = PostRebuildEvent.make({
              _tag: "post-rebuild",
              app: ref,
              timestamp: timestamp(),
            });
            yield* events.publish(postRebuild);
            yield* runAppEvent(plan, "post-rebuild", postRebuild);
            return {
              app: start.app,
              servicesRebuilt: start.servicesStarted.map((service) => service.name),
              servicesStarted: start.servicesStarted,
            };
          }).pipe(Effect.provide(context)),
      }),
    );
  });
