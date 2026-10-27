import { makeAppliedPlanStore } from "@lando/container-runtime/applied-state";

const store = makeAppliedPlanStore({ providerId: "podman", layout: "record" });

export const {
  listAppliedPlans,
  listObservedPlans,
  loadAppliedPlan,
  loadAppliedPlanStrict,
  persistAppliedPlan,
  removeAppliedPlan,
} = store;
