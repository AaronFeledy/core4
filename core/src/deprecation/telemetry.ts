import { Effect, Layer, Stream } from "effect";

import { EventService, Telemetry } from "@lando/sdk/services";

export const DeprecationTelemetryLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const telemetry = yield* Telemetry;
    if (!telemetry.enabled) return;

    const events = yield* EventService;
    const queue = yield* events.subscribeQueue;
    yield* Stream.fromQueue(queue).pipe(
      Stream.filter((event) => event._tag === "deprecation-used"),
      Stream.runForEach((event) =>
        event.use === undefined ? Effect.void : telemetry.record("deprecation-used", { use: event.use }),
      ),
      Effect.catchAll(() => Effect.void),
      Effect.forkScoped,
    );
  }),
);
