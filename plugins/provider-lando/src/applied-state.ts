import { readdir } from "node:fs/promises";

import { Effect } from "effect";

import { ProviderUnavailableError } from "@lando/sdk/errors";
import type { PluginStateStore } from "@lando/sdk/plugins";
import { AppId, AppPlan } from "@lando/sdk/schema";

const PROVIDER_ID = "lando";
const APPLIED_STATE_VERSION = 1;
const APPLIED_PLAN_NAMESPACE = "applied-plans";

export const appliedPlansDir = (stateDir: string): string =>
  `${stateDir.replace(/\/+$/u, "")}/${APPLIED_PLAN_NAMESPACE}`;

export const appliedPlanPath = (stateDir: string, appId: AppId): string =>
  `${appliedPlansDir(stateDir)}/${appId}.json`;

const openAppliedPlanBucket = (stateStore: PluginStateStore, appId: AppId) =>
  stateStore.open({
    namespace: APPLIED_PLAN_NAMESPACE,
    key: `${appId}.json`,
    schema: AppPlan,
    version: APPLIED_STATE_VERSION,
    codec: "json",
    mode: 0o600,
    lock: "advisory",
    onCorrupt: "discard",
    onVersionMismatch: "discard",
  });

export const persistAppliedPlan = (
  stateStore: PluginStateStore,
  plan: AppPlan,
): Effect.Effect<string, ProviderUnavailableError> =>
  openAppliedPlanBucket(stateStore, plan.id).pipe(
    Effect.flatMap((bucket) => bucket.set(plan).pipe(Effect.as(bucket.path))),
    Effect.mapError(
      (cause) =>
        new ProviderUnavailableError({
          providerId: PROVIDER_ID,
          operation: "applied-state.persist",
          message: "Unable to write provider-lando applied plan state.",
          remediation: "Check permissions for the provider-lando plugin state directory and retry.",
          cause,
        }),
    ),
  );

// Missing, corrupt, version-mismatched, and unreadable state remains a cache miss.
export const loadAppliedPlan = (
  stateStore: PluginStateStore,
  appId: AppId,
): Effect.Effect<AppPlan | undefined, never> =>
  openAppliedPlanBucket(stateStore, appId).pipe(
    Effect.flatMap((bucket) => bucket.get),
    Effect.map((plan) => plan ?? undefined),
    Effect.catchAll(() => Effect.succeed(undefined)),
  );

export const removeAppliedPlan = (
  stateStore: PluginStateStore,
  appId: AppId,
): Effect.Effect<void, ProviderUnavailableError> =>
  openAppliedPlanBucket(stateStore, appId).pipe(
    Effect.flatMap((bucket) => bucket.remove),
    Effect.mapError(
      (cause) =>
        new ProviderUnavailableError({
          providerId: PROVIDER_ID,
          operation: "applied-state.remove",
          message: "Unable to remove provider-lando applied plan state.",
          remediation: "Check permissions for the provider-lando plugin state directory and retry.",
          cause,
        }),
    ),
  );

export const listAppliedPlans = (
  stateStore: PluginStateStore,
  stateDir: string,
): Effect.Effect<ReadonlyArray<AppPlan>, never> =>
  Effect.tryPromise(() => readdir(appliedPlansDir(stateDir))).pipe(
    Effect.map((entries) =>
      entries.flatMap((entry) => {
        if (!entry.endsWith(".json")) return [];
        try {
          return [AppId.make(entry.slice(0, -".json".length))];
        } catch {
          return [];
        }
      }),
    ),
    Effect.flatMap((ids) => Effect.forEach(ids, (id) => loadAppliedPlan(stateStore, id))),
    Effect.map((plans) => plans.filter((plan): plan is AppPlan => plan !== undefined)),
    Effect.catchAll(() => Effect.succeed([])),
  );
