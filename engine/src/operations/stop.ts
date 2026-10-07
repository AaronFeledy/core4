import { Effect, Schema } from "effect";

import type { StopAppError as SdkStopAppError, StopAppOptions, StopAppResult } from "@lando/sdk/app";
import type { ComposeKeyRejectedError, LandofileLoadExpressionError } from "@lando/sdk/errors";
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
import { appLockTarget, withAppMutationLock } from "./app-mutation-lock.ts";
import {
  type TeardownResolution,
  teardownDesiredOrUnchanged,
  validateResolvedAppTarget,
  withTeardownResolution,
} from "./applied-state-target.ts";
import { runAppInitEvents } from "./events.ts";
import { tearDownOrphans } from "./orphan-teardown.ts";
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

const unchangedResult = (app: string): StopAppResult => ({
  app,
  outcome: "unchanged",
  servicesStopped: [],
});

const stopAppWithResolvedPlan = (
  options: StopAppOptions | undefined,
  target: ResolvedAppTarget,
  revalidate: boolean,
  requireAppliedEvidence: boolean,
  runInitEvents = true,
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
      const validatedTarget = revalidate ? yield* validateResolvedAppTarget(target) : target;
      if (requireAppliedEvidence && registry.resolveAppliedPlan !== undefined) {
        const appliedPlan = yield* registry.resolveAppliedPlan(validatedTarget.plan.root);
        if (appliedPlan === undefined) {
          return {
            result: unchangedResult(validatedTarget.plan.name),
            plan: validatedTarget.plan,
          };
        }
      }
      const resolvedTarget = yield* resolveMysqlVolumeTarget(validatedTarget, registry);
      const provider = yield* registry.select(resolvedTarget.plan);
      return yield* withPlanVolumeCoordination({
        plan: resolvedTarget.plan,
        provider,
        stateStore,
        body: Effect.fnUntraced(function* () {
          yield* verifyActiveVolumeCoordination(provider);
          const preflight = yield* preflightStopApp(resolvedTarget);
          if (runInitEvents && validatedTarget.landofile !== undefined)
            yield* runAppInitEvents(resolvedTarget.plan);
          return yield* stopAppWithPlanUnlocked(options ?? {}, resolvedTarget, false, preflight);
        }, Effect.provide(context)),
      });
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
          stopAppWithResolvedPlan(options, resolved, false, true, execution.skipInitEvents !== true),
        ),
      )
    : stopAppWithResolvedPlan(
        options,
        target,
        true,
        target.landofile !== undefined,
        execution.skipInitEvents !== true,
      );
});

export const stopAppForTarget = Effect.fn("AppOperation.stopForTarget")(function* (
  options: StopAppOptions | undefined,
  target: ResolvedAppTarget,
  afterSuccess?: Effect.Effect<void>,
): Effect.fn.Return<StopAppResult, SdkStopAppError, BoundStopAppServices> {
  return yield* stopAppWithResolvedPlan(options, target, true, target.landofile !== undefined).pipe(
    Effect.tap(() => afterSuccess ?? Effect.void),
    Effect.map(({ result }) => result),
  );
});

const stopOrphans = (
  resolution: Extract<TeardownResolution, { readonly kind: "orphans" }>,
): Effect.Effect<StopAppResult, StopAppError, StopAppServices> =>
  tearDownOrphans({
    root: resolution.root,
    groups: resolution.groups,
    options: { volumes: false, purgeCaches: false },
  }).pipe(
    Effect.map(
      (removed): StopAppResult =>
        removed.services.length === 0
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
      stopAppWithResolvedPlan(options, desired, false, true).pipe(Effect.map(({ result }) => result)),
    unchangedResult,
  );

export const stopApp = Effect.fn("AppOperation.stop")(function* (
  options: StopAppOptions = {},
  target?: ResolvedAppTarget,
): Effect.fn.Return<StopAppResult, StopAppError, StopAppServices> {
  return yield* target !== undefined
    ? stopAppForTarget(options, target)
    : withTeardownResolution({
        applied: (resolved) =>
          stopAppWithResolvedPlan(options, resolved, false, false).pipe(Effect.map(({ result }) => result)),
        orphans: (resolution) => stopOrphans(resolution),
        absent: (resolution) => stopDesiredOrUnchanged(options, resolution),
      }).pipe(
        Effect.map(
          (result): StopAppResult =>
            result.outcome === "unchanged" ? result : { ...result, outcome: "stopped" },
        ),
      );
});
