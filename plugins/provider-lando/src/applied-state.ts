import type { PluginStateStore } from "@lando/sdk/plugins";
import { type AppId, AppPlan } from "@lando/sdk/schema";
import { Effect } from "effect";

import {
  APPLIED_STATE_VERSION,
  appliedPlanPath,
  appliedPlansDir,
  makeAppliedPlanStore,
  migrateAppliedPlan,
} from "@lando/container-runtime/applied-state";

const store = makeAppliedPlanStore({ providerId: "lando", layout: "per-app" });

export { APPLIED_STATE_VERSION, appliedPlanPath, appliedPlansDir, migrateAppliedPlan };
export const { listAppliedPlans, loadAppliedPlan, persistAppliedPlan, removeAppliedPlan } = store;

/** Missing state is distinct from unreadable state when deciding a safe teardown. */
export type AppliedPlanRead =
  | { readonly status: "missing" }
  | { readonly status: "readable"; readonly plan: AppPlan }
  | { readonly status: "unreadable" };

export const inspectAppliedPlan = (
  stateStore: PluginStateStore,
  appId: AppId,
): Effect.Effect<AppliedPlanRead> =>
  stateStore
    .open({
      namespace: "applied-plans",
      key: `${appId}.json`,
      schema: AppPlan,
      version: APPLIED_STATE_VERSION,
      codec: "json",
      mode: 0o600,
      lock: "advisory",
      onCorrupt: "fail",
      onVersionMismatch: migrateAppliedPlan,
    })
    .pipe(
      Effect.flatMap((bucket) =>
        bucket.exists.pipe(
          Effect.flatMap((exists) =>
            exists
              ? bucket.get.pipe(
                  Effect.map(
                    (plan): AppliedPlanRead =>
                      plan === null ? { status: "unreadable" } : { status: "readable", plan },
                  ),
                )
              : Effect.succeed<AppliedPlanRead>({ status: "missing" }),
          ),
        ),
      ),
      Effect.catch(() => Effect.succeed<AppliedPlanRead>({ status: "unreadable" })),
    );
