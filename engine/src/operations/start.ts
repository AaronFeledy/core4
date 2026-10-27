import { Effect } from "effect";

import type { StartAppOptions } from "@lando/sdk/app";
import { type BuildOptions, RuntimeProviderRegistry, StateStore } from "@lando/sdk/services";

import { type ResolvedAppTarget, resolveDesiredAppTarget } from "../landofile/app-resolution.ts";
import { withPlanVolumeCoordination } from "../lifecycle/volume-coordination.ts";
import { resolveMysqlVolumeTarget } from "../planner/mysql-volume.ts";
import { ensureAppPlacementState } from "../providers/app-placement.ts";
import { appLockTarget, withAppMutationLock } from "./app-mutation-lock.ts";
import { runAppInitEvents } from "./events.ts";
import { publishHomeTransitionNotices, withHomeTransitionNotices } from "./home-transition-notice.ts";
import type { StartManagedScope } from "./start-file-sync.ts";
import {
  ensureStartTransactionConsistent,
  preflightStartAppDrain,
  startAppForTargetUnlocked,
} from "./start-internal.ts";

export type { StartAppError, StartAppOptions, StartAppResult } from "./start-internal.ts";
export { StartedServiceResultSchema, StartAppResultSchema } from "./start-internal.ts";
export type { CheckResult } from "@lando/sdk/schema";
export type { StartManagedScope } from "./start-file-sync.ts";

export const startAppForTarget = Effect.fn("AppOperation.startForTarget")(function* (
  options: StartAppOptions | undefined,
  target: ResolvedAppTarget,
  managed?: StartManagedScope,
  execution: {
    readonly buildOptions?: BuildOptions;
    readonly forceAppBuild?: boolean;
    readonly beforeStart?: Effect.Effect<void>;
    readonly skipInitEvents?: boolean;
    readonly transactionPreflightDone?: boolean;
  } = {},
) {
  return yield* withHomeTransitionNotices(
    withAppMutationLock(
      appLockTarget(target.plan),
      Effect.gen(function* () {
        const placement = yield* ensureAppPlacementState(target.app, target.plan.provider);
        const context =
          yield* Effect.context<Effect.Services<ReturnType<typeof startAppForTargetUnlocked>>>();
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
                Effect.flatMap((preparedTargets) =>
                  Effect.gen(function* () {
                    yield* execution.transactionPreflightDone === true
                      ? Effect.void
                      : ensureStartTransactionConsistent(resolvedTarget);
                    if (execution.skipInitEvents !== true) yield* runAppInitEvents(plan);
                    yield* (execution.beforeStart ?? Effect.void).pipe(Effect.uninterruptible);
                    yield* publishHomeTransitionNotices(placement.plan, plan);
                    return yield* startAppForTargetUnlocked(options, resolvedTarget, managed, {
                      ...execution,
                      ...(preparedTargets === undefined ? {} : { preparedTargets }),
                    });
                  }),
                ),
              )
              .pipe(Effect.provide(context)),
        });
      }),
    ),
  );
});

export const startApp = Effect.fn("AppOperation.start")(function* (
  options: StartAppOptions = {},
  target?: ResolvedAppTarget,
  managed?: StartManagedScope,
  execution: {
    readonly buildOptions?: BuildOptions;
    readonly forceAppBuild?: boolean;
    readonly beforeStart?: Effect.Effect<void>;
    readonly skipInitEvents?: boolean;
    readonly transactionPreflightDone?: boolean;
  } = {},
) {
  return yield* target === undefined
    ? resolveDesiredAppTarget.pipe(
        Effect.flatMap((resolved) => startAppForTarget(options, resolved, managed, execution)),
      )
    : startAppForTarget(options, target, managed, execution);
});
