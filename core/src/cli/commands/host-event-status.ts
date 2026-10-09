import { Predicate, Schema } from "effect";

import { LANDO_HOST_EVENT_ENV, type LandofileEvents } from "@lando/sdk/schema";

import { compileEffectiveEvents, hostEventStatusesForApp } from "@lando/engine/planner/effective-events";
import { loadGlobalConfigSync } from "@lando/engine/services/config";

export const HostEventAppStatus = Schema.Struct({
  event: Schema.String,
  index: Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  step: Schema.Unknown,
  status: Schema.Literals(["ran", "skipped", "deduped"]),
  reason: Schema.optionalKey(Schema.String),
});
export type HostEventAppStatus = typeof HostEventAppStatus.Type;

const servicesFromUnknown = (
  value: unknown,
): Readonly<Record<string, { readonly primary?: boolean }>> | undefined => {
  if (!Predicate.isObject(value)) return undefined;
  return Object.fromEntries(
    Object.entries(value).map(([name, service]) => [
      name,
      { primary: Predicate.isObject(service) && service.primary === true },
    ]),
  );
};

export const hostEventStatusesForLandofile = (landofile: {
  readonly events?: unknown;
  readonly services?: unknown;
}): ReadonlyArray<HostEventAppStatus> => {
  let hostEvents: ReturnType<typeof loadGlobalConfigSync>["hostEvents"];
  try {
    hostEvents = loadGlobalConfigSync().hostEvents;
  } catch {
    return [];
  }
  if (hostEvents === undefined) return [];
  const services = servicesFromUnknown(landofile.services);
  const events = landofile.events as LandofileEvents | undefined;
  try {
    return hostEventStatusesForApp(
      compileEffectiveEvents({
        landofile: events === undefined ? {} : { events },
        hostEvents,
        ...(services === undefined ? {} : { services }),
        skipHostEvents: process.env[LANDO_HOST_EVENT_ENV] === "1",
      }),
    );
  } catch {
    return [];
  }
};

export const renderHostEventStatuses = (statuses: ReadonlyArray<HostEventAppStatus>): ReadonlyArray<string> =>
  statuses.map((entry) => {
    const reason = entry.reason === undefined ? "" : ` (${entry.reason})`;
    return `hostEvents.${entry.event}[${entry.index}]\t${entry.status}${reason}`;
  });
