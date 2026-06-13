import { Effect, Layer, Stream } from "effect";

import type { DeprecationUsedEvent } from "@lando/sdk/events";
import { EventService, Telemetry } from "@lando/sdk/services";
import { deprecationUsedTelemetryData } from "../telemetry/events.ts";

const isDeprecationUsedEvent = (event: unknown): event is DeprecationUsedEvent =>
  typeof event === "object" &&
  event !== null &&
  (event as { readonly _tag?: unknown })._tag === "deprecation-used";

export const DeprecationTelemetryLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const telemetry = yield* Telemetry;
    if (!telemetry.enabled) return;

    const events = yield* EventService;
    const queue = yield* events.subscribeQueue;
    yield* Stream.fromQueue(queue).pipe(
      Stream.filter(isDeprecationUsedEvent),
      Stream.runForEach((event) =>
        telemetry.record("deprecation-used", deprecationUsedTelemetryData(event.use)),
      ),
      Effect.catchAll(() => Effect.void),
      Effect.forkScoped,
    );
  }),
);
