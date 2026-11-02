import { authoredInvocationSites, compileInvocationSites } from "@lando/landofile/compiled-sites";
import type { AppPlan, LandofileEvents } from "@lando/sdk/schema";
import { Effect } from "effect";
import { withProjectEvents } from "../../src/planner/effective-events.ts";
import { attachInvocationAuthority } from "../../src/planner/invocation-authority.ts";

/** This fixture boundary admits authored event text, unlike runtime plan consumers. */
export const withAuthoredProjectEvents = <Plan extends AppPlan>(
  plan: Plan,
  events: LandofileEvents,
): Plan => {
  const document = { events };
  const sites = Effect.runSync(
    compileInvocationSites(authoredInvocationSites(document, plan.metadata.source), {}, document),
  );
  return attachInvocationAuthority(withProjectEvents(plan, events), { sites });
};
