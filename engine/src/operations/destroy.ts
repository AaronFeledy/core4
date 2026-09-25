import { basename } from "node:path";

import { DateTime, Effect, Option, Schema } from "effect";

import type {
  DestroyAppOptions,
  DestroyAppResult,
  DestroyAppError as SdkDestroyAppError,
} from "@lando/sdk/app";
import {
  type ComposeKeyRejectedError,
  FileSyncStopError,
  type LandofileLoadExpressionError,
} from "@lando/sdk/errors";
import { MessageWarnEvent, PostDestroyEvent, PreDestroyEvent } from "@lando/sdk/events";
import type { AppPlan, AppRef } from "@lando/sdk/schema";
import {
  AppPlanner,
  EventService,
  FileSyncEngine,
  LandofileService,
  PathsService,
  RouterService,
  RuntimeProviderRegistry,
  StateStore,
} from "@lando/sdk/services";
import type { PrivateFileAccessService } from "@lando/state-store/private-file-access";

import { deleteCwdAppMapEntriesForRoot } from "../cache/cwd-app-map.ts";
import { resolveUserCacheRoot } from "../cache/paths.ts";
import { type ResolvedAppTarget, loadUserLandofile } from "../landofile/app-resolution.ts";
import { runAllAndMergeFailures } from "../lifecycle/failure-compensation.ts";
import {
  verifyActiveVolumeCoordination,
  withPlanVolumeCoordination,
} from "../lifecycle/volume-coordination.ts";
import { resolveMysqlVolumeTarget } from "../planner/mysql-volume.ts";

import { cleanupHostProxyRunLandoState } from "../subsystems/host-proxy/transport.ts";
import { requireNoPendingAcceleratedStop } from "./accelerated-start-journal.ts";
import { appLockTarget, withAppMutationLock } from "./app-mutation-lock.ts";
import {
  type TeardownResolution,
  resolveTeardownResolution,
  validateResolvedAppTarget,
} from "./applied-state-target.ts";
import { withDestroyProgress } from "./destroy-progress.ts";
import { runAppEvent, runAppInitEvents } from "./events.ts";
import { hasExactFileSyncSessionCoverage, terminateFileSyncSessions } from "./file-sync.ts";
import { tearDownOrphans } from "./orphan-teardown.ts";

export type DestroyAppError = SdkDestroyAppError | ComposeKeyRejectedError | LandofileLoadExpressionError;
export type { DestroyAppOptions, DestroyAppResult } from "@lando/sdk/app";

export const DestroyAppResultSchema = Schema.Struct({
  app: Schema.String,
  outcome: Schema.optional(Schema.Literal("destroyed", "unchanged")),
  servicesDestroyed: Schema.Array(Schema.String),
  volumesRemoved: Schema.Boolean,
});

type DestroyAppServices =
  | AppPlanner
  | EventService
  | LandofileService
  | PathsService
  | PrivateFileAccessService
  | StateStore
  | RuntimeProviderRegistry;
type BoundDestroyAppServices = Exclude<DestroyAppServices, AppPlanner | LandofileService>;

const now = () => DateTime.unsafeMake(new Date().toISOString());

const appRef = (plan: AppPlan): AppRef => ({ kind: "user", id: plan.id, root: plan.root });

const resolveDesiredTarget = Effect.gen(function* () {
  const landofileService = yield* LandofileService;
  const registry = yield* RuntimeProviderRegistry;
  const planner = yield* AppPlanner;
  const landofile = yield* loadUserLandofile(landofileService);
  const capabilities = yield* registry.capabilities;
  const plan = yield* planner.plan(landofile, capabilities);
  return { plan, root: plan.root, app: appRef(plan), landofile } satisfies ResolvedAppTarget;
});

const unchangedResult = (app: string): DestroyAppResult => ({
  app,
  outcome: "unchanged",
  servicesDestroyed: [],
  volumesRemoved: false,
});

const destroyAppForTargetUncoordinated = (
  options: DestroyAppOptions | undefined,
  target: ResolvedAppTarget,
): Effect.Effect<DestroyAppResult, SdkDestroyAppError, BoundDestroyAppServices> =>
  Effect.gen(function* () {
    yield* requireNoPendingAcceleratedStop(target.app, target.plan);
    const resolvedOptions = options ?? {};
    const registry = yield* RuntimeProviderRegistry;
    const events = yield* EventService;
    const paths = yield* PathsService;
    const proxy = yield* Effect.serviceOption(RouterService);

    const plan = target.plan;
    const provider = yield* registry.select(plan);
    const ref = target.app;
    const volumes = resolvedOptions.volumes ?? false;
    const appliedFileSync =
      provider.inspectAppliedFileSync === undefined
        ? {
            status:
              plan.fileSync.length > 0 && provider.prepareFileSyncTargets !== undefined
                ? ("unknown" as const)
                : ("ordinary" as const),
          }
        : yield* provider.inspectAppliedFileSync(plan);
    if (appliedFileSync.status === "unknown") {
      return yield* Effect.fail(
        new FileSyncStopError({
          engineId: plan.fileSync[0]?.engineId ?? "unavailable",
          sessionRef: String(plan.id),
          message:
            "Previous file sync state could not be verified; destroying may lose unsynchronized changes.",
          remediation: "Inspect and repair the file sync session and provider state, then retry destroy.",
        }),
      );
    }

    const selectedFileSync = yield* Effect.serviceOption(FileSyncEngine);
    if (
      appliedFileSync.status === "accelerated" &&
      Option.isSome(selectedFileSync) &&
      selectedFileSync.value.appLifecycle !== undefined
    ) {
      return yield* Effect.fail(
        new FileSyncStopError({
          engineId: selectedFileSync.value.id,
          sessionRef: String(plan.id),
          message: "Durable file sync disposal requires verified provider cleanup.",
          remediation:
            "Keep the app stopped and preserve its sync sessions and volumes until provider cleanup can verify ownership.",
        }),
      );
    }

    const fileSyncApplicable =
      appliedFileSync.status === "accelerated" &&
      (yield* Option.match(selectedFileSync, {
        onNone: () => Effect.succeed(false),
        onSome: (engine) => engine.isAvailable,
      }));
    const sessions =
      fileSyncApplicable && Option.isSome(selectedFileSync)
        ? yield* selectedFileSync.value.listSessions({ app: ref })
        : [];
    if (
      appliedFileSync.status === "accelerated" &&
      (appliedFileSync.engineId !==
        (Option.isSome(selectedFileSync) ? selectedFileSync.value.id : undefined) ||
        !hasExactFileSyncSessionCoverage(appliedFileSync.sessions, sessions))
    ) {
      return yield* Effect.fail(
        new FileSyncStopError({
          engineId: appliedFileSync.engineId,
          sessionRef: String(sessions[0]?.ref ?? plan.id),
          message:
            "An accelerated mount has no matching file sync session; destroying its volume could lose changes.",
          remediation: "Repair or resume the file sync session, then retry destroy.",
        }),
      );
    }
    const quiesceForFileSync = provider.quiesceForFileSync;
    if (sessions.length > 0 && quiesceForFileSync === undefined) {
      return yield* Effect.fail(
        new FileSyncStopError({
          engineId: appliedFileSync.status === "accelerated" ? appliedFileSync.engineId : "unavailable",
          sessionRef: String(sessions[0]?.ref ?? plan.id),
          message: "This provider cannot stop app writes before flushing file sync.",
          remediation: "Use a provider with file sync quiescence support, then retry destroy.",
        }),
      );
    }

    yield* runAppInitEvents(plan);
    const preDestroy = PreDestroyEvent.make({
      _tag: "pre-destroy",
      app: ref,
      timestamp: now(),
    });
    yield* events.publish(preDestroy);
    yield* runAppEvent(plan, "pre-destroy", preDestroy);

    yield* withDestroyProgress({
      events,
      plan,
      children: {
        fileSync: fileSyncApplicable,
        proxy: proxy._tag === "Some",
        snapshots: false,
      },
      work: (tree) =>
        Effect.gen(function* () {
          if (fileSyncApplicable) yield* tree.startTask("file-sync");
          if (sessions.length > 0 && quiesceForFileSync !== undefined) {
            yield* quiesceForFileSync({ app: plan.id, plan });
            yield* terminateFileSyncSessions(ref, sessions);
          }
          if (fileSyncApplicable) yield* tree.completeTask("file-sync");

          yield* tree.startTask("provider");
          const providerDestroy = verifyActiveVolumeCoordination(provider).pipe(
            Effect.zipRight(
              provider.destroy(
                { app: plan.id, plan },
                {
                  volumes,
                  ...(resolvedOptions.purgeCaches === undefined
                    ? {}
                    : { purgeCaches: resolvedOptions.purgeCaches }),
                  removeState: true,
                },
              ),
            ),
            Effect.ensuring(
              Effect.gen(function* () {
                yield* tree.startTask("host-proxy");
                yield* cleanupHostProxyRunLandoState(ref, { ...paths.roots, platform: paths.platform });
                yield* tree.completeTask("host-proxy");
              }),
            ),
            Effect.tap(() => tree.completeTask("provider")),
            Effect.tapError(() => tree.failTask("provider")),
          );
          if (proxy._tag === "Some") {
            const removeRoutes = tree.startTask("routes").pipe(
              Effect.zipRight(proxy.value.removeRoutes(plan.id)),
              Effect.tap(() => tree.completeTask("routes")),
              Effect.tapError(() => tree.failTask("routes")),
            );
            yield* runAllAndMergeFailures<SdkDestroyAppError, PrivateFileAccessService>([
              providerDestroy,
              removeRoutes,
            ]);
          } else {
            yield* events.publish(
              MessageWarnEvent.make({
                body: `Proxy service is unavailable; destroying ${plan.name} without route cleanup.`,
                timestamp: now(),
              }),
            );
            yield* providerDestroy;
          }
        }),
    });

    const postDestroy = PostDestroyEvent.make({
      _tag: "post-destroy",
      app: ref,
      timestamp: now(),
    });
    yield* events.publish(postDestroy);
    yield* runAppEvent(plan, "post-destroy", postDestroy);
    yield* deleteCwdAppMapEntriesForRoot({ cacheRoot: resolveUserCacheRoot(), appRoot: plan.root });

    return {
      app: plan.name,
      servicesDestroyed: Object.values(plan.services)
        .reverse()
        .map((service) => String(service.name)),
      volumesRemoved: volumes || resolvedOptions.purgeCaches === true,
    };
  });

const destroyAppWithResolvedTarget = (
  options: DestroyAppOptions | undefined,
  target: ResolvedAppTarget,
  revalidate: boolean,
  requireAppliedEvidence: boolean,
): Effect.Effect<DestroyAppResult, SdkDestroyAppError, BoundDestroyAppServices> =>
  withAppMutationLock(
    appLockTarget(target.plan),
    Effect.gen(function* () {
      const context = yield* Effect.context<BoundDestroyAppServices>();
      const registry = yield* RuntimeProviderRegistry;
      const stateStore = yield* StateStore;
      const validatedTarget = revalidate ? yield* validateResolvedAppTarget(target) : target;
      if (requireAppliedEvidence && registry.resolveAppliedPlan !== undefined) {
        const appliedPlan = yield* registry.resolveAppliedPlan(validatedTarget.plan.root);
        if (appliedPlan === undefined) {
          return unchangedResult(validatedTarget.plan.name);
        }
      }
      const resolvedTarget = yield* resolveMysqlVolumeTarget(validatedTarget, registry);
      const provider = yield* registry.select(resolvedTarget.plan);
      return yield* withPlanVolumeCoordination({
        plan: resolvedTarget.plan,
        provider,
        stateStore,
        body: () => destroyAppForTargetUncoordinated(options, resolvedTarget).pipe(Effect.provide(context)),
      });
    }),
  );

export const destroyAppForTarget = (
  options: DestroyAppOptions | undefined,
  target: ResolvedAppTarget,
  afterSuccess?: Effect.Effect<void>,
): Effect.Effect<DestroyAppResult, SdkDestroyAppError, BoundDestroyAppServices> =>
  destroyAppWithResolvedTarget(options, target, true, target.landofile !== undefined).pipe(
    Effect.tap(() => afterSuccess ?? Effect.void),
  );

const destroyOrphans = (
  options: DestroyAppOptions,
  resolution: Extract<TeardownResolution, { readonly kind: "orphans" }>,
): Effect.Effect<DestroyAppResult, DestroyAppError, DestroyAppServices> =>
  tearDownOrphans({
    root: resolution.root,
    groups: resolution.groups,
    options: { volumes: options.volumes === true, purgeCaches: options.purgeCaches === true },
  }).pipe(
    Effect.map(
      (removed): DestroyAppResult =>
        removed.services.length === 0 && !removed.volumesRemoved
          ? unchangedResult(removed.app)
          : {
              app: removed.app,
              outcome: "destroyed",
              servicesDestroyed: removed.services,
              volumesRemoved: removed.volumesRemoved,
            },
    ),
  );

const destroyDesiredOrUnchanged = (
  options: DestroyAppOptions,
  resolution: Extract<TeardownResolution, { readonly kind: "absent" }>,
): Effect.Effect<DestroyAppResult, DestroyAppError, DestroyAppServices> =>
  resolveDesiredTarget.pipe(
    Effect.map((desired): ResolvedAppTarget | undefined => desired),
    Effect.catchAll((error) =>
      resolution.landofilePresent ? Effect.succeed(undefined) : Effect.fail(error),
    ),
    Effect.flatMap((desired) =>
      desired === undefined
        ? Effect.succeed(unchangedResult(basename(resolution.root)))
        : destroyAppWithResolvedTarget(options, desired, false, true),
    ),
  );

export const destroyApp = (
  options: DestroyAppOptions = {},
  target?: ResolvedAppTarget,
): Effect.Effect<DestroyAppResult, DestroyAppError, DestroyAppServices> =>
  target !== undefined
    ? destroyAppForTarget(options, target)
    : resolveTeardownResolution.pipe(
        Effect.flatMap((resolution) => {
          switch (resolution.kind) {
            case "applied":
              return destroyAppWithResolvedTarget(options, resolution.target, false, false);
            case "orphans":
              return destroyOrphans(options, resolution);
            case "absent":
              return destroyDesiredOrUnchanged(options, resolution);
          }
        }),
        Effect.map(
          (result): DestroyAppResult =>
            result.outcome === "unchanged" ? result : { ...result, outcome: "destroyed" },
        ),
      );
