import type { AppPlan } from "@lando/sdk/schema";
import { attachEffectiveEvents, compiledEventsForPlan } from "./effective-events.ts";
import { attachEffectiveTooling, effectiveToolingForPlan } from "./effective-tooling.ts";
import { attachInvocationAuthority, invocationAuthorityForPlan } from "./invocation-authority.ts";

export const carryPlanAttachments = <Plan extends AppPlan>(from: AppPlan, to: Plan): Plan => {
  const events = compiledEventsForPlan(from);
  const tooling = effectiveToolingForPlan(from);
  const withTooling = tooling === undefined ? to : attachEffectiveTooling(to, tooling);
  const authority = invocationAuthorityForPlan(from);
  const annotated = authority === undefined ? withTooling : attachInvocationAuthority(withTooling, authority);
  if (events !== undefined) attachEffectiveEvents(annotated, events);
  return annotated;
};
