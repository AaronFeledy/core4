import { makeAppliedPlanStore } from "@lando/container-runtime/applied-state";

export {
  APPLIED_STATE_VERSION,
  type AppliedPlanRead,
  appliedPlanPath,
  appliedPlansDir,
  appliedStateInspectError,
  migrateAppliedPlan,
  unreadableAppliedStateError,
} from "@lando/container-runtime/applied-state";

const store = makeAppliedPlanStore({ providerId: "lando", layout: "per-app" });
export const {
  listAppliedPlans,
  loadAppliedPlanStrict,
  inspectAppliedPlan,
  persistAppliedPlan,
  removeAppliedPlan,
} = store;
