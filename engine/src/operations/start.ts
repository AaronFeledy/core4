import { Effect, Exit } from "effect";

import type { StartAppOptions } from "@lando/sdk/app";
import { RuntimeProviderRegistry, StateStore } from "@lando/sdk/services";

import { type ResolvedAppTarget, resolveDesiredAppTarget } from "../landofile/app-resolution.ts";
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

export const startAppForTarget = Effect.fn("AppOperation.startForTarget")(function* (
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
) {
  return yield* withAppMutationLock(
    appLockTarget(target.plan),
    Effect.gen(function* () {
      const context = yield* Effect.context<Effect.Services<ReturnType<typeof startAppForTargetUnlocked>>>();
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
          preflightStartAppDrain(resolvedTarget, undefined, true)
            .pipe(
              Effect.andThen(
                execution.transactionPreflightDone === true
                  ? Effect.void
                  : ensureStartTransactionConsistent(resolvedTarget),
              ),
              Effect.andThen(execution.skipInitEvents === true ? Effect.void : runAppInitEvents(plan)),
              Effect.andThen((execution.beforeStart ?? Effect.void).pipe(Effect.uninterruptible)),
              Effect.andThen(startAppForTargetUnlocked(options, resolvedTarget, managed, execution)),
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
});

export const startApp = Effect.fn("AppOperation.start")(function* (
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
) {
  return yield* target === undefined
    ? resolveDesiredAppTarget.pipe(
        Effect.flatMap((resolved) => startAppForTarget(options, resolved, managed, execution)),
      )
    : startAppForTarget(options, target, managed, execution);
});
