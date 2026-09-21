import { makeAppliedPlanStore } from "@lando/container-runtime/applied-state";

const store = makeAppliedPlanStore({ providerId: "podman", layout: "record" });

export const { listAppliedPlans, loadAppliedPlan, persistAppliedPlan, removeAppliedPlan } = store;
