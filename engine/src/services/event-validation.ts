import { Cause, Effect, Schema } from "effect";

import { EventError } from "@lando/sdk/errors";
import { LandoEvent as LandoEventSchema } from "@lando/sdk/events";
import type { EventWaitSpec, LandoEvent } from "@lando/sdk/services";

export const eventError = (event: string, message: string, cause?: unknown): EventError =>
  new EventError({ message, event, ...(cause === undefined ? {} : { cause }) });

export const timeoutEventError = (event: string): EventError =>
  new EventError({ message: `Timed out waiting for event: ${event}`, event, reason: "timeout" });

const DeliverableEventSchema = Schema.Union([
  Schema.toEncoded(LandoEventSchema),
  Schema.toType(LandoEventSchema),
]);

export const readEventName = (event: LandoEvent): Effect.Effect<string, EventError> =>
  Effect.try({
    try: () => event._tag,
    catch: (cause) => eventError("<unknown>", "Event failed schema validation: <unknown>", cause),
  }).pipe(
    Effect.flatMap((eventName) =>
      typeof eventName === "string"
        ? Effect.succeed(eventName)
        : Effect.fail(eventError("<unknown>", "Event failed schema validation: <unknown>")),
    ),
  );

export const decodeDeliverableEvent = (
  event: LandoEvent,
  eventName: string,
): Effect.Effect<LandoEvent, EventError> =>
  Schema.decodeUnknownEffect(DeliverableEventSchema)(event, { onExcessProperty: "error" }).pipe(
    Effect.mapError((cause) => eventError(eventName, `Event failed schema validation: ${eventName}`, cause)),
    Effect.catchCauseIf(Cause.hasDies, (cause) =>
      Effect.fail(eventError(eventName, `Event failed schema validation: ${eventName}`, cause)),
    ),
    Effect.as(event),
  );

export const matchesName = (name: string, event: LandoEvent): boolean => name === "*" || event._tag === name;

export const matchesSpec = (spec: EventWaitSpec, event: LandoEvent): boolean => {
  if (!matchesName(spec.name, event)) return false;
  return spec.filter?.(event as never) ?? true;
};
