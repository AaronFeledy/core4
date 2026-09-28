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
  readonly load: (state: PluginStateStore, appId: AppId) => Effect.Effect<AppPlan | undefined, never>;
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
  const sanitize = options.sanitizeAppliedPlan ?? ((plan: AppPlan) => plan);

  const resolvePlan = (appId: AppId): Effect.Effect<AppPlan | undefined, never> => {
    const cached = plans.get(appId);
    if (cached !== undefined) return Effect.succeed(cached);
    if (state === undefined) return Effect.succeed(undefined);
    return options.load(state, appId).pipe(
      Effect.tap((loaded) =>
        Effect.sync(() => {
          if (loaded !== undefined) plans.set(appId, loaded);
        }),
      ),
    );
  };

  const rememberPlan = (plan: AppPlan, reconcile: boolean): Effect.Effect<void, ProviderUnavailableError> => {
    const write = Effect.gen(function* () {
      const previous = reconcile
        ? undefined
        : state === undefined
          ? yield* resolvePlan(plan.id)
          : yield* options.load(state, plan.id);
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

  const forgetPlan = (appId: AppId): Effect.Effect<void, ProviderUnavailableError> => {
    plans.delete(appId);
    return state === undefined ? Effect.void : options.remove(state, appId);
  };

  return { plans, resolvePlan, rememberPlan, forgetPlan };
};
