import type { AppPlan, AppRef } from "@lando/sdk/schema";
import { SCRATCH_EXTENSION_KEY } from "../scratch-app/identity.ts";

/** Root matching is separate: scratch identities can share a user app's root. */
export const matchesAppPlanIdentity = (plan: AppPlan, app: Pick<AppRef, "kind" | "id">): boolean =>
  app.kind === "scratch"
    ? plan.id === app.id && Object.hasOwn(plan.extensions, SCRATCH_EXTENSION_KEY)
    : !Object.hasOwn(plan.extensions, SCRATCH_EXTENSION_KEY);
