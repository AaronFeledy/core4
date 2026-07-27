import { Context } from "effect";

import type { AppPlan } from "../schema/index.ts";

export interface AppPlanSanitizerShape {
  readonly sanitizeForPersistence: (plan: AppPlan) => AppPlan;
}

export class AppPlanSanitizer extends Context.Tag("@lando/core/AppPlanSanitizer")<
  AppPlanSanitizer,
  AppPlanSanitizerShape
>() {}
