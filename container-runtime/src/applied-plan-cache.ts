import { mapFailures } from "@lando/sdk/command-result";
import { AppliedStateVersionError, ProviderUnavailableError } from "@lando/sdk/errors";
import type { PluginStateStore } from "@lando/sdk/plugins";
import type { AppId, AppPlan, AppliedAppPlan, ProviderId } from "@lando/sdk/schema";
import { Effect } from "effect";

import { mergeAppliedPlan } from "./plan.ts";

export interface AppliedPlanCacheOptions {
  readonly providerId: ProviderId;
  readonly providerName: string;
  readonly appliedPlanState?: PluginStateStore;
  readonly sanitizeAppliedPlan?: (plan: AppPlan) => AppPlan;
  readonly load: (
    state: PluginStateStore,
    appId: AppId,
  ) => Effect.Effect<AppliedAppPlan | undefined, AppliedPlanCacheError>;
  readonly persist: (
    state: PluginStateStore,
    plan: AppliedAppPlan,
  ) => Effect.Effect<unknown, AppliedPlanCacheError>;
  readonly remove: (state: PluginStateStore, appId: AppId) => Effect.Effect<void, AppliedPlanCacheError>;
}

export type AppliedPlanCacheError = ProviderUnavailableError | AppliedStateVersionError;

const LOCK_REMEDIATION = "Retry after the concurrent app operation completes.";

export const makeAppliedPlanCache = (options: AppliedPlanCacheOptions) => {
  const plans = new Map<AppId, AppliedAppPlan>();
  const state = options.appliedPlanState;
  const sanitize = (plan: AppliedAppPlan): AppliedAppPlan => {
    if (options.sanitizeAppliedPlan === undefined) return plan;
    const { events: _events, ...applied } = options.sanitizeAppliedPlan(plan);
    return applied;
  };

  const resolveMutationPlan = (
    appId: AppId,
  ): Effect.Effect<AppliedAppPlan | undefined, AppliedPlanCacheError> => {
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
  const resolvePlan = (appId: AppId): Effect.Effect<AppliedAppPlan | undefined> => {
    const cached = plans.get(appId);
    if (cached !== undefined) return Effect.succeed(cached);
    return resolveMutationPlan(appId).pipe(Effect.catch(() => Effect.succeed(undefined)));
  };

  const rememberPlan = (
    plan: AppPlan,
    mode: { readonly complete?: boolean } = {},
  ): Effect.Effect<void, AppliedPlanCacheError> => {
    const write = Effect.gen(function* () {
      const previous = yield* resolveMutationPlan(plan.id);
      const persisted = sanitize(mergeAppliedPlan(previous, plan, mode));
      if (state !== undefined) yield* options.persist(state, persisted);
      plans.set(plan.id, persisted);
    });
    if (state === undefined) return write;
    return state.withLock(`applied-plan-${plan.id}`, write).pipe(
      mapFailures((cause) =>
        cause instanceof ProviderUnavailableError || cause instanceof AppliedStateVersionError
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
  const forgetPlan = (appId: AppId): Effect.Effect<void, AppliedPlanCacheError> =>
    (state === undefined ? Effect.void : options.remove(state, appId)).pipe(
      Effect.tap(() => Effect.sync(() => plans.delete(appId))),
    );

  return { plans, resolvePlan, resolveMutationPlan, rememberPlan, forgetPlan };
};
