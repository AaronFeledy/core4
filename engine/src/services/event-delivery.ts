import type { EventError } from "@lando/sdk/errors";
import type { EventServiceShape, LandoEvent } from "@lando/sdk/services";
import { Context, Effect, Layer, MutableRef, PubSub, Queue, Ref, Result, Schema } from "effect";
import { DeliverableEventSchema, eventError } from "./event-validation.ts";

export interface EventDeliveryMetricsSnapshot {
  readonly capacity: number;
  /** Number of event deliveries rejected by full subscriber queues. */
  readonly droppedEvents: number;
}

export class EventDeliveryMetrics extends Context.Service<
  EventDeliveryMetrics,
  { readonly snapshot: Effect.Effect<EventDeliveryMetricsSnapshot> }
>()("@lando/engine/EventDeliveryMetrics") {
  static readonly layer = (service: Context.Service.Shape<typeof EventDeliveryMetrics>) =>
    Layer.succeed(this, this.of(service));
}

export interface EventDeliveryState {
  readonly subscribers: Set<PubSub.PubSub<LandoEvent>>;
  readonly queueSubscribers: Set<Queue.Queue<LandoEvent>>;
  readonly historySubscribers: Map<Queue.Queue<LandoEvent>, MutableRef.MutableRef<number>>;
  readonly deliveryQueueCapacity: number;
  readonly history: Ref.Ref<ReadonlyArray<LandoEvent>>;
  readonly historyCap: number;
  readonly droppedEvents: Ref.Ref<number>;
  readonly instrumentation: {
    readonly onPayloadDecode?: () => void;
    readonly onPubSubPublish?: () => void;
  };
}

export const makeEventDelivery = (state: EventDeliveryState) => {
  const trackedSubscribe = Effect.gen(function* () {
    const pubsub = yield* PubSub.dropping<LandoEvent>(state.deliveryQueueCapacity);
    const queue = yield* PubSub.subscribe(pubsub);
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        state.subscribers.add(pubsub);
      }),
      () =>
        Effect.sync(() => {
          state.subscribers.delete(pubsub);
        }).pipe(Effect.andThen(PubSub.shutdown(pubsub))),
    );
    return queue;
  });
  const trackedSubscribeQueue = Effect.acquireRelease(
    Queue.dropping<LandoEvent>(state.deliveryQueueCapacity).pipe(
      Effect.tap((queue) =>
        Effect.sync(() => {
          state.queueSubscribers.add(queue);
        }),
      ),
    ),
    (queue) =>
      Effect.sync(() => {
        state.queueSubscribers.delete(queue);
      }).pipe(Effect.andThen(Queue.shutdown(queue))),
  );
  const subscribeWithHistory: EventServiceShape["subscribeWithHistory"] = (options) =>
    Effect.acquireRelease(
      Queue.dropping<LandoEvent>(options?.capacity ?? state.deliveryQueueCapacity).pipe(
        Effect.flatMap((queue) =>
          Effect.sync(() => {
            const dropped = MutableRef.make(0);
            state.historySubscribers.set(queue, dropped);
            return {
              history: Ref.getUnsafe(state.history),
              queue,
              dropped: Effect.sync(() => dropped.current),
              stop: Effect.sync(() => {
                state.historySubscribers.delete(queue);
              }),
            };
          }),
        ),
      ),
      (subscription) => subscription.stop.pipe(Effect.andThen(Queue.shutdown(subscription.queue))),
    );

  const commitPublication = (
    event: LandoEvent,
    safe: LandoEvent,
    hasManifest: boolean,
  ): Effect.Effect<void, EventError> =>
    Effect.sync(() => {
      const hasDelivery =
        hasManifest ||
        state.subscribers.size > 0 ||
        state.queueSubscribers.size > 0 ||
        state.historySubscribers.size > 0;
      if (hasDelivery) {
        state.instrumentation.onPayloadDecode?.();
        const decoded = Schema.decodeUnknownResult(DeliverableEventSchema)(event, {
          onExcessProperty: "error",
        });
        if (Result.isFailure(decoded))
          return Effect.fail(
            eventError(event._tag, `Event failed schema validation: ${event._tag}`, decoded.failure),
          );
      }
      if (state.historyCap > 0) {
        const retained = Ref.getUnsafe(state.history);
        MutableRef.set(
          state.history.ref,
          Object.freeze([...retained.slice(Math.max(0, retained.length - state.historyCap + 1)), safe]),
        );
      }
      if (!hasDelivery) return Effect.void;
      state.instrumentation.onPubSubPublish?.();
      let rejectedDeliveries = 0;
      for (const pubsub of state.subscribers) {
        if (!PubSub.publishUnsafe(pubsub, safe)) rejectedDeliveries += 1;
      }
      for (const queue of state.queueSubscribers) {
        if (!Queue.offerUnsafe(queue, safe)) rejectedDeliveries += 1;
      }
      for (const [queue, dropped] of state.historySubscribers) {
        if (!Queue.offerUnsafe(queue, safe)) {
          MutableRef.set(dropped, dropped.current + 1);
          rejectedDeliveries += 1;
        }
      }
      MutableRef.set(state.droppedEvents.ref, Ref.getUnsafe(state.droppedEvents) + rejectedDeliveries);
      return Effect.void;
    }).pipe(Effect.flatten);

  return { trackedSubscribe, trackedSubscribeQueue, subscribeWithHistory, commitPublication };
};
