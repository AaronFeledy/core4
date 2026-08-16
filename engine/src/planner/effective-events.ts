import type { AppPlan, LandofileEvents, LandofileShape } from "@lando/sdk/schema";

interface EventServiceContribution {
  readonly name: string;
  readonly events?: LandofileEvents;
}

const effectiveEventsByPlan = new WeakMap<AppPlan, LandofileEvents>();

const compareOrdinal = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

const sortedEvents = (events: LandofileEvents): LandofileEvents =>
  Object.fromEntries(Object.entries(events).sort(([left], [right]) => compareOrdinal(left, right)));

export const compileEffectiveEvents = (input: {
  readonly landofile: Pick<LandofileShape, "events">;
  readonly services: ReadonlyArray<EventServiceContribution>;
}): LandofileEvents => {
  const contributed: Record<string, LandofileEvents[keyof LandofileEvents]> = {};
  for (const service of [...input.services].sort((left, right) => compareOrdinal(left.name, right.name))) {
    for (const [name, steps] of Object.entries(service.events ?? {}).sort(([left], [right]) =>
      compareOrdinal(left, right),
    )) {
      if (contributed[name] === undefined) contributed[name] = steps;
    }
  }
  return sortedEvents({ ...contributed, ...input.landofile.events });
};

export const attachEffectiveEvents = (plan: AppPlan, events: LandofileEvents): AppPlan => {
  const sorted = sortedEvents(events);
  effectiveEventsByPlan.set(plan, sorted);
  return plan;
};

export const effectiveEventsForPlan = (plan: AppPlan): LandofileEvents | undefined =>
  effectiveEventsByPlan.get(plan);
