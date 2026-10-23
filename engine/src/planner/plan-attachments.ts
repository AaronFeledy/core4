import type { AppPlan } from "@lando/sdk/schema";
import { attachEffectiveTooling, effectiveToolingForPlan } from "./effective-tooling.ts";
import { attachServiceCredsScope, serviceCredsScopeForPlan } from "./landofile-scopes.ts";

/**
 * Tooling and the service creds scope still live in side tables keyed on plan identity, so a
 * plan rewritten by spread has to carry them explicitly. Events travel on the plan value.
 */
export const carryPlanAttachments = (from: AppPlan, to: AppPlan): AppPlan => {
  const tooling = effectiveToolingForPlan(from);
  const credsScope = serviceCredsScopeForPlan(from);
  if (tooling !== undefined) attachEffectiveTooling(to, tooling);
  if (credsScope !== undefined) attachServiceCredsScope(to, credsScope);
  return to;
};
