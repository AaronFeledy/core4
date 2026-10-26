import { makeAppliedPlanStore } from "@lando/container-runtime/applied-state";

export {
  APPLIED_STATE_VERSION,
  appliedPlanPath,
  appliedPlansDir,
  migrateAppliedPlan,
  type AppliedPlanRead,
} from "@lando/container-runtime/applied-state";

const store = makeAppliedPlanStore({ providerId: "lando", layout: "per-app" });
export const {
  listAppliedPlans,
  listObservedPlans,
  loadAppliedPlan,
  loadAppliedPlanStrict,
  inspectAppliedPlan,
  persistAppliedPlan,
  removeAppliedPlan,
} = store;
