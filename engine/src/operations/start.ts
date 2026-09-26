import { Effect, Exit } from "effect";

import type { StartAppOptions } from "@lando/sdk/app";
import type { AppPlan, AppRef } from "@lando/sdk/schema";
import { AppPlanner, LandofileService, RuntimeProviderRegistry, StateStore } from "@lando/sdk/services";

import { type ResolvedAppTarget, loadUserLandofile } from "../landofile/app-resolution.ts";
import { withPlanVolumeCoordination } from "../lifecycle/volume-coordination.ts";
import { resolveMysqlVolumeTarget } from "../planner/mysql-volume.ts";
import { appLockTarget, withAppMutationLock } from "./app-mutation-lock.ts";
import { runAppInitEvents } from "./events.ts";
import type { StartManagedScope } from "./start-file-sync.ts";
import {
  ensureStartTransactionConsistent,
  preflightStartAppDrain,
  startAppForTargetUnlocked,
} from "./start-internal.ts";

export type { StartAppError, StartAppOptions, StartAppResult } from "./start-internal.ts";
export { StartedServiceResultSchema, StartAppResultSchema } from "./start-internal.ts";
export type { StartManagedScope } from "./start-file-sync.ts";

const appRef = (plan: AppPlan): AppRef => ({ kind: "user", id: plan.id, root: plan.root });

export const startAppForTarget = (
  options: StartAppOptions | undefined,
  target: ResolvedAppTarget,
  managed?: StartManagedScope,
  execution: {
    readonly forceAppBuild?: boolean;
    readonly beforeStart?: Effect.Effect<void>;
    readonly onFailedStart?: Effect.Effect<void>;
    readonly skipInitEvents?: boolean;
    readonly transactionPreflightDone?: boolean;
  } = {},
) =>
  withAppMutationLock(
    appLockTarget(target.plan),
    Effect.gen(function* () {
      const context =
        yield* Effect.context<Effect.Effect.Context<ReturnType<typeof startAppForTargetUnlocked>>>();
      const registry = yield* RuntimeProviderRegistry;
      const stateStore = yield* StateStore;
      const resolvedTarget = yield* resolveMysqlVolumeTarget(target, registry);
      const plan = resolvedTarget.plan;
      const provider = yield* registry.select(plan);
      return yield* withPlanVolumeCoordination({
        plan,
        provider,
        stateStore,
        body: () =>
          preflightStartAppDrain(resolvedTarget)
            .pipe(
              Effect.zipRight(
                execution.transactionPreflightDone === true
                  ? Effect.void
                  : ensureStartTransactionConsistent(resolvedTarget),
              ),
              Effect.zipRight(execution.skipInitEvents === true ? Effect.void : runAppInitEvents(plan)),
              Effect.zipRight((execution.beforeStart ?? Effect.void).pipe(Effect.uninterruptible)),
              Effect.zipRight(startAppForTargetUnlocked(options, resolvedTarget, managed, execution)),
              Effect.onExit((exit) =>
                Exit.isFailure(exit)
                  ? (execution.onFailedStart ?? Effect.void).pipe(Effect.uninterruptible)
                  : Effect.void,
              ),
            )
            .pipe(Effect.provide(context)),
      });
    }),
  );

export const startApp = (
  options: StartAppOptions = {},
  target?: ResolvedAppTarget,
  managed?: StartManagedScope,
  execution: {
    readonly forceAppBuild?: boolean;
    readonly beforeStart?: Effect.Effect<void>;
    readonly onFailedStart?: Effect.Effect<void>;
    readonly skipInitEvents?: boolean;
    readonly transactionPreflightDone?: boolean;
  } = {},
) =>
  target === undefined
    ? Effect.gen(function* () {
        const landofileService = yield* LandofileService;
        const registry = yield* RuntimeProviderRegistry;
        const planner = yield* AppPlanner;
        const landofile = yield* loadUserLandofile(landofileService);
        const capabilities = yield* registry.capabilities;
        const plan = yield* planner.plan(landofile, capabilities);
        return yield* startAppForTarget(
          options,
          { plan, root: plan.root, app: appRef(plan), landofile },
          managed,
          execution,
        );
      })
    : startAppForTarget(options, target, managed, execution);
