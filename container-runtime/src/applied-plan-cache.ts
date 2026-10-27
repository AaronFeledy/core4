import { Effect } from "effect";

import { ProviderUnavailableError } from "@lando/sdk/errors";
import type { PluginStateStore } from "@lando/sdk/plugins";
import type { AppId, AppPlan, ProviderId } from "@lando/sdk/schema";

import { mergeAppliedPlan } from "./plan.ts";

export interface AppliedPlanCacheOptions {
  readonly providerId: ProviderId;
  readonly providerName: string;
  readonly appliedPlanState?: PluginStateStore;
  readonly sanitizeAppliedPlan?: (plan: AppPlan) => AppPlan;
  readonly load: (
    state: PluginStateStore,
    appId: AppId,
  ) => Effect.Effect<AppPlan | undefined, ProviderUnavailableError>;
  readonly persist: (
    state: PluginStateStore,
    plan: AppPlan,
  ) => Effect.Effect<unknown, ProviderUnavailableError>;
  readonly remove: (state: PluginStateStore, appId: AppId) => Effect.Effect<void, ProviderUnavailableError>;
}

const LOCK_REMEDIATION = "Retry after the concurrent app operation completes.";

export const makeAppliedPlanCache = (options: AppliedPlanCacheOptions) => {
  const plans = new Map<AppId, AppPlan>();
  const state = options.appliedPlanState;
  const sanitize = (plan: AppPlan): AppPlan => {
    const { events: _events, ...applied } = options.sanitizeAppliedPlan?.(plan) ?? plan;
    return applied;
  };

  const resolveMutationPlan = (
    appId: AppId,
  ): Effect.Effect<AppPlan | undefined, ProviderUnavailableError> => {
    if (state === undefined) return Effect.sync(() => plans.get(appId));
    return options.load(state, appId).pipe(
      Effect.map((loaded) => (loaded === undefined ? undefined : sanitize(loaded))),
      Effect.tap((loaded) =>
        Effect.sync(() => {
          if (loaded !== undefined) plans.set(appId, loaded);
          else plans.delete(appId);
        }),
      ),
      Effect.tapError(() => Effect.sync(() => plans.delete(appId))),
    );
  };
  // Observation reuses the cached plan (rememberPlan and forgetPlan keep it current);
  // only mutation pays for a fresh strict read, and unreadable state observes as unknown.
  const resolvePlan = (appId: AppId): Effect.Effect<AppPlan | undefined> => {
    const cached = plans.get(appId);
    if (cached !== undefined) return Effect.succeed(cached);
    return resolveMutationPlan(appId).pipe(Effect.catch(() => Effect.succeed(undefined)));
  };

  const rememberPlan = (plan: AppPlan, reconcile: boolean): Effect.Effect<void, ProviderUnavailableError> => {
    const write = Effect.gen(function* () {
      const previous = yield* resolveMutationPlan(plan.id);
      const persisted = sanitize(mergeAppliedPlan(previous, plan, reconcile));
      if (state !== undefined) yield* options.persist(state, persisted);
      plans.set(plan.id, persisted);
    });
    if (state === undefined) return write;
    return state.withLock(`applied-plan-${plan.id}`, write).pipe(
      Effect.mapError((cause) =>
        cause instanceof ProviderUnavailableError
          ? cause
          : new ProviderUnavailableError({
              providerId: options.providerId,
              operation: "applied-state.lock",
              message: `Unable to lock ${options.providerName} applied plan state.`,
              remediation: LOCK_REMEDIATION,
              cause,
            }),
      ),
    );
  };

  // The cached plan is dropped only once state removal succeeds, so a failed
  // removal leaves the cache consistent with what is still on disk.
  const forgetPlan = (appId: AppId): Effect.Effect<void, ProviderUnavailableError> =>
    (state === undefined ? Effect.void : options.remove(state, appId)).pipe(
      Effect.tap(() => Effect.sync(() => plans.delete(appId))),
    );

  return { plans, resolvePlan, resolveMutationPlan, rememberPlan, forgetPlan };
};
