import { Effect, Schema } from "effect";

import type { StopAppError as SdkStopAppError, StopAppOptions, StopAppResult } from "@lando/sdk/app";
import {
  type ComposeKeyRejectedError,
  FileSyncStopError,
  type LandofileLoadExpressionError,
} from "@lando/sdk/errors";
import type { AppPlan } from "@lando/sdk/schema";
import {
  type AppPlanner,
  type EventService,
  type LandofileService,
  type PathsService,
  RuntimeProviderRegistry,
  StateStore,
} from "@lando/sdk/services";
import type { PrivateFileAccessService } from "@lando/state-store/private-file-access";

import { type ResolvedAppTarget, resolveDesiredAppTarget } from "../landofile/app-resolution.ts";
import {
  verifyActiveVolumeCoordination,
  withPlanVolumeCoordination,
} from "../lifecycle/volume-coordination.ts";
import { resolveMysqlVolumeTarget } from "../planner/mysql-volume.ts";
import { readDiscardableStart } from "./accelerated-start-disposal.ts";
import { appLockTarget, withAppMutationLock } from "./app-mutation-lock.ts";
import {
  type TeardownResolution,
  teardownDesiredOrUnchanged,
  validateResolvedAppTarget,
  withTeardownResolution,
} from "./applied-state-target.ts";
import { runAppInitEvents } from "./events.ts";
import { tearDownOrphans } from "./orphan-teardown.ts";
import {
  ownedCleanupChanged,
  prepareOwnedResourceCleanup,
  tearDownOwnedResources,
} from "./owned-resource-teardown.ts";
import { preflightStopApp, stopAppWithPlanUnlocked } from "./stop-internal.ts";

export type StopAppError = SdkStopAppError | ComposeKeyRejectedError | LandofileLoadExpressionError;
export type { StopAppOptions, StopAppResult } from "@lando/sdk/app";

export const StopAppResultSchema = Schema.Struct({
  app: Schema.String,
  outcome: Schema.optionalKey(Schema.Literals(["stopped", "unchanged"])),
  servicesStopped: Schema.Array(Schema.String),
});

type StopAppServices =
  | AppPlanner
  | EventService
  | LandofileService
  | PathsService
  | PrivateFileAccessService
  | RuntimeProviderRegistry
  | StateStore;
type BoundStopAppServices = Exclude<StopAppServices, AppPlanner | LandofileService>;
type StopExecution = {
  readonly revalidate: boolean;
  readonly requireAppliedEvidence: boolean;
  readonly runInitEvents?: boolean;
  readonly cleanupOwnership?: boolean;
};

const unchangedResult = (app: string): StopAppResult => ({
  app,
  outcome: "unchanged",
  servicesStopped: [],
});

const stopAppWithResolvedPlan = (
  options: StopAppOptions | undefined,
  target: ResolvedAppTarget,
  execution: StopExecution,
): Effect.Effect<
  { readonly result: StopAppResult; readonly plan: AppPlan },
  SdkStopAppError,
  BoundStopAppServices
> =>
  withAppMutationLock(
    appLockTarget(target.plan),
    Effect.gen(function* () {
      const context = yield* Effect.context<BoundStopAppServices>();
      const registry = yield* RuntimeProviderRegistry;
      const stateStore = yield* StateStore;
      const validatedTarget = execution.revalidate ? yield* validateResolvedAppTarget(target) : target;
      const { pending } = yield* readDiscardableStart(validatedTarget.app);
      const cleanup =
        execution.cleanupOwnership !== false
          ? yield* prepareOwnedResourceCleanup(validatedTarget.root, {
              volumes: false,
              purgeCaches: false,
            })
          : Effect.succeed({ servicesRemoved: [], networksRemoved: 0, volumesRemoved: 0 });
      if ((pending === null || pending.phase === "completed") && execution.requireAppliedEvidence) {
        const evidence =
          execution.cleanupOwnership === false
            ? yield* registry
                .resolveAppliedPlan(validatedTarget.plan.root)
                .pipe(
                  Effect.map((plan) =>
                    plan === undefined ? { kind: "absent" as const } : { kind: "applied" as const, plan },
                  ),
                )
            : yield* registry.resolveTeardownEvidence(validatedTarget.plan.root);
        switch (evidence.kind) {
          case "applied":
            break;
          case "orphans":
            return {
              result: yield* stopOrphans({
                kind: "orphans",
                root: validatedTarget.root,
                groups: evidence.groups,
                landofilePresent: true,
              }),
              plan: validatedTarget.plan,
            };
          case "owned":
          case "absent": {
            const removed = yield* cleanup;
            return {
              result: {
                app: validatedTarget.plan.name,
                outcome: ownedCleanupChanged(removed) ? "stopped" : "unchanged",
                servicesStopped: removed.servicesRemoved,
              },
              plan: validatedTarget.plan,
            };
          }
        }
      }
      const resolvedTarget = yield* resolveMysqlVolumeTarget(validatedTarget, registry);
      const provider = yield* registry.select(resolvedTarget.plan);
      const stopped = yield* withPlanVolumeCoordination({
        plan: resolvedTarget.plan,
        provider,
        stateStore,
        body: Effect.fnUntraced(function* () {
          yield* verifyActiveVolumeCoordination(provider);
          const preflight = yield* preflightStopApp(resolvedTarget);
          if (execution.runInitEvents !== false && validatedTarget.landofile !== undefined)
            yield* runAppInitEvents(resolvedTarget.plan);
          return yield* stopAppWithPlanUnlocked(options ?? {}, resolvedTarget, false, preflight);
        }, Effect.provide(context)),
      });
      const removed = yield* cleanup;
      return {
        ...stopped,
        result: {
          ...stopped.result,
          outcome:
            stopped.result.outcome !== "unchanged" || ownedCleanupChanged(removed)
              ? ("stopped" as const)
              : ("unchanged" as const),
          servicesStopped: [...new Set([...stopped.result.servicesStopped, ...removed.servicesRemoved])],
        },
      };
    }),
  );

export const stopAppWithPlan = Effect.fn("AppOperation.stopWithPlan")(function* (
  options: StopAppOptions = {},
  target?: ResolvedAppTarget,
  execution: { readonly skipInitEvents?: boolean } = {},
): Effect.fn.Return<
  { readonly result: StopAppResult; readonly plan: AppPlan },
  StopAppError,
  StopAppServices
> {
  return yield* target === undefined
    ? resolveDesiredAppTarget.pipe(
        Effect.flatMap((resolved) =>
          stopAppWithResolvedPlan(options, resolved, {
            revalidate: false,
            requireAppliedEvidence: true,
            runInitEvents: execution.skipInitEvents !== true,
            cleanupOwnership: false,
          }),
        ),
      )
    : stopAppWithResolvedPlan(options, target, {
        revalidate: true,
        requireAppliedEvidence: target.landofile !== undefined,
        runInitEvents: execution.skipInitEvents !== true,
        cleanupOwnership: false,
      });
});

export const stopAppForTarget = Effect.fn("AppOperation.stopForTarget")(function* (
  options: StopAppOptions | undefined,
  target: ResolvedAppTarget,
  afterSuccess?: Effect.Effect<void>,
): Effect.fn.Return<StopAppResult, SdkStopAppError, BoundStopAppServices> {
  return yield* stopAppWithResolvedPlan(options, target, {
    revalidate: true,
    requireAppliedEvidence: target.landofile !== undefined,
  }).pipe(
    Effect.tap(() => afterSuccess ?? Effect.void),
    Effect.map(({ result }) => result),
  );
});

const stopOrphans = (
  resolution: Extract<TeardownResolution, { readonly kind: "orphans" }>,
): Effect.Effect<StopAppResult, SdkStopAppError, BoundStopAppServices> =>
  tearDownOrphans({
    root: resolution.root,
    groups: resolution.groups,
    options: { volumes: false, purgeCaches: false },
  }).pipe(
    Effect.map(
      (removed): StopAppResult =>
        removed.services.length === 0 && !removed.ownedChanged
          ? unchangedResult(removed.app)
          : { app: removed.app, outcome: "stopped", servicesStopped: removed.services },
    ),
  );

const stopDesiredOrUnchanged = (
  options: StopAppOptions,
  resolution: Extract<TeardownResolution, { readonly kind: "absent" }>,
): Effect.Effect<StopAppResult, StopAppError, StopAppServices> =>
  teardownDesiredOrUnchanged(
    resolution,
    (desired) =>
      stopAppWithResolvedPlan(options, desired, { revalidate: false, requireAppliedEvidence: true }).pipe(
        Effect.map(({ result }) => result),
      ),
    unchangedResult,
  );

export const stopApp = Effect.fn("AppOperation.stop")(function* (
  options: StopAppOptions = {},
  target?: ResolvedAppTarget,
): Effect.fn.Return<StopAppResult, StopAppError, StopAppServices> {
  return yield* target !== undefined
    ? stopAppForTarget(options, target)
    : withTeardownResolution({
        owned: Effect.fnUntraced(function* (resolution) {
          const { pending } = yield* readDiscardableStart({
            kind: "user",
            id: resolution.ownership[0]?.appIds[0] ?? "unknown",
            root: resolution.root,
          });
          if (pending !== null && pending.phase !== "completed") {
            const desired = yield* resolveDesiredAppTarget;
            if (desired.root !== resolution.root)
              return yield* Effect.fail(
                new FileSyncStopError({
                  engineId: pending.engineId,
                  sessionRef: pending.appId,
                  message: "The desired app root differs from the pending stop target.",
                  remediation:
                    "Restore the matching Landofile and run `lando stop` in the recorded app root.",
                }),
              );
            return (yield* stopAppWithResolvedPlan(options, desired, {
              revalidate: false,
              requireAppliedEvidence: false,
            })).result;
          }
          return yield* tearDownOwnedResources(resolution.root, { volumes: false, purgeCaches: false }).pipe(
            Effect.map(
              (removed): StopAppResult => ({
                app: resolution.ownership[0]?.appIds[0] ?? resolution.root,
                outcome: ownedCleanupChanged(removed) ? "stopped" : "unchanged",
                servicesStopped: removed.servicesRemoved,
              }),
            ),
          );
        }),
        applied: Effect.fnUntraced(function* (resolved) {
          const { pending } = yield* readDiscardableStart(resolved.app);
          if (pending !== null && pending.phase !== "completed") {
            const desired = yield* resolveDesiredAppTarget;
            if (desired.root !== resolved.root || desired.app.id !== resolved.app.id)
              return yield* Effect.fail(
                new FileSyncStopError({
                  engineId: pending.engineId,
                  sessionRef: pending.appId,
                  message: "The desired app identity differs from pending applied runtime state.",
                  remediation:
                    "Restore the matching Landofile and retry `lando stop` in the recorded app root.",
                }),
              );
            return (yield* stopAppWithResolvedPlan(options, desired, {
              revalidate: false,
              requireAppliedEvidence: false,
            })).result;
          }
          return yield* stopAppWithResolvedPlan(options, resolved, {
            revalidate: false,
            requireAppliedEvidence: false,
          }).pipe(Effect.map(({ result }) => result));
        }),
        orphans: Effect.fnUntraced(function* (resolution) {
          const first = resolution.groups[0];
          const { pending } = yield* readDiscardableStart({
            kind: "user",
            id: first?.appId ?? "unknown",
            root: resolution.root,
          });
          if (pending !== null && pending.phase !== "completed") {
            const desired = yield* resolveDesiredAppTarget;
            if (desired.root !== resolution.root)
              return yield* Effect.fail(
                new FileSyncStopError({
                  engineId: pending.engineId,
                  sessionRef: pending.appId,
                  message: "The desired app root differs from the pending stop target.",
                  remediation:
                    "Restore the matching Landofile and run `lando stop` in the recorded app root.",
                }),
              );
            return (yield* stopAppWithResolvedPlan(options, desired, {
              revalidate: false,
              requireAppliedEvidence: false,
            })).result;
          }
          return yield* stopOrphans(resolution);
        }),
        absent: (resolution) => stopDesiredOrUnchanged(options, resolution),
      }).pipe(
        Effect.map(
          (result): StopAppResult =>
            result.outcome === "unchanged" ? result : { ...result, outcome: "stopped" },
        ),
      );
});
