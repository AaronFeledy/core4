import { type Context, Effect, Layer, Option, PubSub, Stream } from "effect";

import { EventError } from "@lando/sdk/errors";
import { EventService, type LandoEvent } from "@lando/sdk/services";

const eventError = (event: string, message: string, cause?: unknown): EventError =>
  new EventError({ message, event, ...(cause === undefined ? {} : { cause }) });

const makeEventService = (pubsub: PubSub.PubSub<LandoEvent>): Context.Tag.Service<typeof EventService> => {
  const service: Context.Tag.Service<typeof EventService> = {
    publish: (event) =>
      PubSub.publish(pubsub, event).pipe(
        Effect.asVoid,
        Effect.catchAllCause((cause) =>
          Effect.fail(eventError(event._tag, `Failed to publish event: ${event._tag}`, cause)),
        ),
      ),
    subscribe: (name) =>
      Stream.fromPubSub(pubsub).pipe(Stream.filter((event) => name === "*" || event._tag === name)),
    waitFor: (name, filter) =>
      service.subscribe(name).pipe(
        Stream.filter((event) => filter?.(event) ?? true),
        Stream.runHead,
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(eventError(name, `Event stream ended before receiving event: ${name}`)),
            onSome: Effect.succeed,
          }),
        ),
      ),
  };

  return service;
};

export const EventServiceLive = Layer.scoped(
  EventService,
  Effect.gen(function* () {
    const pubsub = yield* PubSub.unbounded<LandoEvent>();
    yield* Effect.addFinalizer(() => PubSub.shutdown(pubsub));
    return makeEventService(pubsub);
  }),
);
