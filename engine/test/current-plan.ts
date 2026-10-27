import type { AppPlan, CurrentExecutableAppPlan } from "@lando/sdk/schema";

export const currentTestPlan = (plan: AppPlan): CurrentExecutableAppPlan => {
  return { ...plan, valueModel: 1 };
};
