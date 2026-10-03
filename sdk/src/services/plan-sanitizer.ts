import { Context } from "effect";

import type { AppPlan } from "../schema/index.ts";

export class AppPlanSanitizer extends Context.Service<
  AppPlanSanitizer,
  {
    readonly sanitizeForPersistence: (plan: AppPlan) => AppPlan;
  }
>()("@lando/core/AppPlanSanitizer") {}

export type AppPlanSanitizerShape = AppPlanSanitizer["Service"];
