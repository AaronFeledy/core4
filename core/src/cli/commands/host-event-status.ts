import { Predicate, Schema } from "effect";

import { HostEventStep, LANDO_HOST_EVENT_ENV } from "@lando/sdk/schema";
import type { LandofileShape } from "@lando/sdk/schema";

import {
  compileEffectiveEvents,
  hostEventStatusesForApp,
} from "@lando/engine/planner/effective-events";
import { loadGlobalConfigSync } from "@lando/engine/services/config";

export const HostEventAppStatus = Schema.Struct({
  event: Schema.String,
  index: Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  step: HostEventStep,
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

export const hostEventStatusesForLandofile = (
  landofile: Pick<LandofileShape, "events" | "services"> | { readonly events?: unknown; readonly services?: unknown },
): ReadonlyArray<HostEventAppStatus> => {
  let hostEvents;
  try {
    hostEvents = loadGlobalConfigSync().hostEvents;
  } catch {
    return [];
  }
  if (hostEvents === undefined) return [];
  const services = servicesFromUnknown(landofile.services);
  try {
    return hostEventStatusesForApp(
      compileEffectiveEvents({
        landofile: { events: landofile.events as LandofileShape["events"] },
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
