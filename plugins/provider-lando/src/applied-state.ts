import {
  appliedPlanPath,
  appliedPlansDir,
  makeAppliedPlanStore,
} from "@lando/container-runtime/applied-state";

const store = makeAppliedPlanStore({ providerId: "lando", layout: "per-app" });

export { appliedPlanPath, appliedPlansDir };
export const { listAppliedPlans, loadAppliedPlan, persistAppliedPlan, removeAppliedPlan } = store;
