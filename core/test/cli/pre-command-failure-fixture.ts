import { Effect, Layer, Queue, Stream } from "effect";

import { type EventFor, EventService, type EventServiceShape, type LandoEvent } from "@lando/sdk/services";

type RecordingHarness = {
  readonly events: Array<LandoEvent>;
  readonly layer: Layer.Layer<EventService>;
};

export const makeRecordingHarness = (): RecordingHarness => {
  const events: Array<LandoEvent> = [];
  const service: EventServiceShape = {
    publish: (event) =>
      Effect.sync(() => {
        events.push(event);
      }),
    subscribe: () => Stream.empty,
    subscribeQueue: Effect.gen(function* () {
      const queue = yield* Queue.unbounded<LandoEvent>();
      yield* Effect.addFinalizer(() => Queue.shutdown(queue));
      return queue;
    }),
    waitFor: () => Effect.never,
    waitForAny: () => Effect.never,
    query: <Name extends string>() => Effect.succeed<ReadonlyArray<EventFor<Name>>>([]),
  };
  return {
    events,
    layer: Layer.succeed(EventService, service),
  };
};
