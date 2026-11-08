import { Effect } from "effect";

import type { StartAppOptions } from "@lando/sdk/app";
import { type BuildOptions, RuntimeProviderRegistry, StateStore } from "@lando/sdk/services";

import { type ResolvedAppTarget, resolveDesiredAppTarget } from "../landofile/app-resolution.ts";
import { withLaunchVolumeCoordination } from "../lifecycle/volume-coordination.ts";
import { ensureAppPlacementState } from "../providers/app-placement.ts";
import { selectPreparedProvider } from "../providers/prepared.ts";
import { appLockTarget, withAppMutationLock } from "./app-mutation-lock.ts";
import { claimAppDataIdentity, claimDataIdentityBeforeRetirement } from "./data-identity-claim.ts";
import { reconcileAppDataIdentity } from "./data-identity-reconcile.ts";
import { runAppInitEvents } from "./events.ts";
import { validateDesiredFileSyncEngine } from "./file-sync-acquire.ts";
import { rotateChangedFileSync } from "./start-file-sync-rotation.ts";
import type { StartManagedScope } from "./start-file-sync.ts";
import {
  ensureStartTransactionConsistent,
  preflightStartAppDrain,
  startAppForTargetUnlocked,
} from "./start-internal.ts";
import { type PreparedStartOverlays, prepareStartOverlays } from "./start-overlays.ts";
import { retireSupersededRealizations } from "./superseded-realizations.ts";
import {
  publishPlacementVolumeTransitionNotices,
  withVolumeTransitionNotices,
} from "./volume-transition-notice.ts";

export type { StartAppError, StartAppOptions, StartAppResult } from "./start-internal.ts";
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
    readonly preparedOverlays?: PreparedStartOverlays;
  } = {},
) {
  return yield* withVolumeTransitionNotices(
    withAppMutationLock(
      appLockTarget(target.plan),
      Effect.gen(function* () {
        // FIRST under root lock: reconcile data identity before overlays, placement, retirement,
        // preflight, or any mutation.
        const reconciled = yield* reconcileAppDataIdentity(target);
        yield* validateDesiredFileSyncEngine(reconciled.plan);
        const providerRegistry = yield* RuntimeProviderRegistry;
        const preparedOverlays =
          (reconciled === target ? execution.preparedOverlays : undefined) ??
          (yield* prepareStartOverlays(reconciled, yield* providerRegistry.select(reconciled.plan)));
        const placement = yield* ensureAppPlacementState(reconciled.app, reconciled.plan.provider);
        const context =
          yield* Effect.context<Effect.Services<ReturnType<typeof startAppForTargetUnlocked>>>();
        const stateStore = yield* StateStore;
        const plan = reconciled.plan;
        const provider = yield* selectPreparedProvider(plan);
        yield* claimDataIdentityBeforeRetirement(reconciled, placement.superseded, provider);
        const retired = yield* retireSupersededRealizations(reconciled, placement.superseded, { provider });
        yield* rotateChangedFileSync(reconciled, provider);
        return yield* withLaunchVolumeCoordination({
          plan,
          provider,
          stateStore,
          body: () =>
            Effect.gen(function* () {
              // After ownership preflight (locate/lock), before any volume-producing mutation.
              yield* claimAppDataIdentity(reconciled);
              return yield* preflightStartAppDrain(reconciled).pipe(
                Effect.flatMap((preparedTargets) =>
                  Effect.gen(function* () {
                    yield* retired || execution.transactionPreflightDone === true
                      ? Effect.void
                      : ensureStartTransactionConsistent(reconciled);
                    if (execution.skipInitEvents !== true) yield* runAppInitEvents(plan);
                    yield* (execution.beforeStart ?? Effect.void).pipe(Effect.uninterruptible);
                    yield* publishPlacementVolumeTransitionNotices(placement, plan);
                    return yield* startAppForTargetUnlocked(options, reconciled, managed, {
                      ...execution,
                      provider,
                      preparedOverlays,
                      ...(preparedTargets === undefined ? {} : { preparedTargets }),
                    });
                  }),
                ),
              );
            }).pipe(Effect.provide(context)),
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
    readonly preparedOverlays?: PreparedStartOverlays;
  } = {},
) {
  return yield* target === undefined
    ? resolveDesiredAppTarget.pipe(
        Effect.flatMap((resolved) => startAppForTarget(options, resolved, managed, execution)),
      )
    : startAppForTarget(options, target, managed, execution);
});
