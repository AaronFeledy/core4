import type { AppPlan } from "@lando/sdk/schema";
import { attachEffectiveEvents, compiledEventsForPlan } from "./effective-events.ts";
import { attachEffectiveTooling, effectiveToolingForPlan } from "./effective-tooling.ts";
import { attachServiceCredsScope, serviceCredsScopeForPlan } from "./landofile-scopes.ts";

export const carryPlanAttachments = (from: AppPlan, to: AppPlan): AppPlan => {
  const events = compiledEventsForPlan(from);
  const tooling = effectiveToolingForPlan(from);
  const credsScope = serviceCredsScopeForPlan(from);
  if (events !== undefined) attachEffectiveEvents(to, events);
  if (tooling !== undefined) attachEffectiveTooling(to, tooling);
  if (credsScope !== undefined) attachServiceCredsScope(to, credsScope);
  return to;
};
