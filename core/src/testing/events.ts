import { Duration, Effect } from "effect";

import type { EventError } from "@lando/sdk/errors";
import { type EventFor, EventService, type EventWaitOptions, type LandoEvent } from "@lando/sdk/services";

const DEFAULT_EXPECT_TIMEOUT = Duration.seconds(5);

/**
 * Awaits the first event named `name` (matching `filter`) from the live
 * stream, defaulting to a bounded test timeout so a missing event fails fast
 * instead of hanging the suite.
 */
export const expectEvent = <Name extends string>(
  name: Name,
  options?: EventWaitOptions<Name>,
): Effect.Effect<EventFor<Name>, EventError, EventService> =>
  Effect.flatMap(EventService, (events) =>
    events.waitFor(name, { timeout: DEFAULT_EXPECT_TIMEOUT, ...options }),
  );

/**
 * Awaits the first event named `name` from the live stream, waiting
 * indefinitely unless a `timeout` is supplied.
 */
export const waitForEvent = <Name extends string>(
  name: Name,
  options?: EventWaitOptions<Name>,
): Effect.Effect<EventFor<Name>, EventError, EventService> =>
  Effect.flatMap(EventService, (events) => events.waitFor(name, options));

/** Snapshots every event in the runtime history buffer (`query("*")`). */
export const recordedEvents = (): Effect.Effect<ReadonlyArray<LandoEvent>, never, EventService> =>
  Effect.flatMap(EventService, (events) => events.query("*"));
