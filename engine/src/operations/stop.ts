import { basename } from "node:path";

import { Effect, Schema } from "effect";

import type { StopAppError as SdkStopAppError, StopAppOptions, StopAppResult } from "@lando/sdk/app";
import type { ComposeKeyRejectedError, LandofileLoadExpressionError } from "@lando/sdk/errors";
import type { AppPlan, AppRef } from "@lando/sdk/schema";
import {
  AppPlanner,
  type EventService,
  LandofileService,
  type PathsService,
  RuntimeProviderRegistry,
  StateStore,
} from "@lando/sdk/services";
import type { PrivateFileAccessService } from "@lando/state-store/private-file-access";

import { type ResolvedAppTarget, loadUserLandofile } from "../landofile/app-resolution.ts";
import {
  verifyActiveVolumeCoordination,
  withPlanVolumeCoordination,
} from "../lifecycle/volume-coordination.ts";
import { resolveMysqlVolumeTarget } from "../planner/mysql-volume.ts";
import { appLockTarget, withAppMutationLock } from "./app-mutation-lock.ts";
import {
  type TeardownResolution,
  resolveTeardownResolution,
  validateResolvedAppTarget,
} from "./applied-state-target.ts";
import { runAppInitEvents } from "./events.ts";
import { tearDownOrphans } from "./orphan-teardown.ts";
import { preflightStopApp, stopAppWithPlanUnlocked } from "./stop-internal.ts";

export type StopAppError = SdkStopAppError | ComposeKeyRejectedError | LandofileLoadExpressionError;
export type { StopAppOptions, StopAppResult } from "@lando/sdk/app";

export const StopAppResultSchema = Schema.Struct({
  app: Schema.String,
  outcome: Schema.optional(Schema.Literal("stopped", "unchanged")),
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
        body: () =>
          Effect.gen(function* () {
            yield* verifyActiveVolumeCoordination(provider);
            const preflight = yield* preflightStopApp(resolvedTarget);
            if (runInitEvents && validatedTarget.landofile !== undefined)
              yield* runAppInitEvents(resolvedTarget.plan);
            return yield* stopAppWithPlanUnlocked(options ?? {}, resolvedTarget, false, preflight);
          }).pipe(Effect.provide(context)),
      });
    }),
  );

export const stopAppWithPlan = (
  options: StopAppOptions = {},
  target?: ResolvedAppTarget,
  execution: { readonly skipInitEvents?: boolean } = {},
): Effect.Effect<
  { readonly result: StopAppResult; readonly plan: AppPlan },
  StopAppError,
  StopAppServices
> =>
  target === undefined
    ? resolveDesiredTarget.pipe(
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

export const stopAppForTarget = (
  options: StopAppOptions | undefined,
  target: ResolvedAppTarget,
  afterSuccess?: Effect.Effect<void>,
): Effect.Effect<StopAppResult, SdkStopAppError, BoundStopAppServices> =>
  stopAppWithResolvedPlan(options, target, true, target.landofile !== undefined).pipe(
    Effect.tap(() => afterSuccess ?? Effect.void),
    Effect.map(({ result }) => result),
  );

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
  resolveDesiredTarget.pipe(
    Effect.map((desired): ResolvedAppTarget | undefined => desired),
    Effect.catchAll((error) =>
      resolution.landofilePresent ? Effect.succeed(undefined) : Effect.fail(error),
    ),
    Effect.flatMap((desired) =>
      desired === undefined
        ? Effect.succeed(unchangedResult(basename(resolution.root)))
        : stopAppWithResolvedPlan(options, desired, false, true).pipe(Effect.map(({ result }) => result)),
    ),
  );

export const stopApp = (
  options: StopAppOptions = {},
  target?: ResolvedAppTarget,
): Effect.Effect<StopAppResult, StopAppError, StopAppServices> =>
  target !== undefined
    ? stopAppForTarget(options, target)
    : resolveTeardownResolution.pipe(
        Effect.flatMap((resolution) => {
          switch (resolution.kind) {
            case "applied":
              return stopAppWithResolvedPlan(options, resolution.target, false, false).pipe(
                Effect.map(({ result }) => result),
              );
            case "orphans":
              return stopOrphans(resolution);
            case "absent":
              return stopDesiredOrUnchanged(options, resolution);
          }
        }),
        Effect.map(
          (result): StopAppResult =>
            result.outcome === "unchanged" ? result : { ...result, outcome: "stopped" },
        ),
      );
