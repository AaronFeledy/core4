import type { AppPlan, LandofileEvents, LandofileShape } from "@lando/sdk/schema";

const effectiveEventsByPlan = new WeakMap<AppPlan, LandofileEvents>();

const compareOrdinal = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

const sortedEvents = (events: LandofileEvents): LandofileEvents =>
  Object.fromEntries(Object.entries(events).sort(([left], [right]) => compareOrdinal(left, right)));

export const compileEffectiveEvents = (input: {
  readonly landofile: Pick<LandofileShape, "events">;
}): LandofileEvents => sortedEvents({ ...input.landofile.events });

export const attachEffectiveEvents = (plan: AppPlan, events: LandofileEvents): AppPlan => {
  effectiveEventsByPlan.set(plan, sortedEvents(events));
  return plan;
};

export const effectiveEventsForPlan = (plan: AppPlan): LandofileEvents | undefined =>
  effectiveEventsByPlan.get(plan);
