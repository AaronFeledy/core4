import type { AppPlan, CurrentExecutableAppPlan } from "@lando/sdk/schema";
import { attachEffectiveEvents, compiledEventsForPlan } from "../src/planner/effective-events.ts";

export const currentTestPlan = (plan: AppPlan): CurrentExecutableAppPlan => {
  const current: CurrentExecutableAppPlan = { ...plan, valueModel: 1 };
  const events = compiledEventsForPlan(plan);
  return events === undefined ? current : attachEffectiveEvents(current, events);
};
