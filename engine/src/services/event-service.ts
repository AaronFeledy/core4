import { Cause, Context, type Duration, Effect, Layer, Option, PubSub, Queue, Ref, Stream } from "effect";

import type { EventError } from "@lando/sdk/errors";
import { ConfigService, type EventFor, EventService, type LandoEvent } from "@lando/sdk/services";

import {
  type RedactionForProfileOptions,
  RedactionService,
  createStandaloneRedactor,
} from "@lando/redaction/service";
import {
  decodeDeliverableEvent,
  eventError,
  matchesName,
  matchesSpec,
  readEventName,
  timeoutEventError,
} from "./event-validation.ts";

const DEFAULT_HISTORY_CAP = 64;
const DEFAULT_DELIVERY_QUEUE_CAPACITY = 64;
const EMPTY_HISTORY: ReadonlyArray<LandoEvent> = Object.freeze([]);

type EventServiceConfig = {
  readonly subscribers: Set<PubSub.PubSub<LandoEvent>>;
  readonly queueSubscribers: Set<Queue.Queue<LandoEvent>>;
  readonly deliveryQueueCapacity: number;
  readonly history: Ref.Ref<ReadonlyArray<LandoEvent>>;
  readonly historyCap: number;
  readonly droppedEvents: Ref.Ref<number>;
  readonly redaction: Option.Option<Context.Service.Shape<typeof RedactionService>>;
  readonly instrumentation: EventServiceInstrumentation;
};

export interface EventServiceInstrumentation {
  readonly onPayloadDecode?: () => void;
  readonly onPubSubPublish?: () => void;
}

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

export type EventDispatcher = (event: LandoEvent) => Effect.Effect<void, EventError>;
export type EventDispatchRegistration = {
  readonly hasSubscribers: (eventName: string) => boolean;
  readonly dispatch: EventDispatcher;
};

export class EventDispatchControl extends Context.Service<
  EventDispatchControl,
  { readonly install: (registration: EventDispatchRegistration) => Effect.Effect<void> }
>()("@lando/engine/EventDispatchControl") {
  static readonly layer = (service: Context.Service.Shape<typeof EventDispatchControl>) =>
    Layer.succeed(this, this.of(service));
}

const HISTORY_REDACTION_PROFILE = "secrets" as const;

const historyRedactionOptions = (): RedactionForProfileOptions => ({ sourceEnv: process.env });

const redactForHistory = (
  redaction: Option.Option<Context.Service.Shape<typeof RedactionService>>,
  event: LandoEvent,
): Effect.Effect<LandoEvent> => {
  const options = historyRedactionOptions();
  return Option.match(redaction, {
    onNone: () =>
      Effect.sync(
        () => createStandaloneRedactor(HISTORY_REDACTION_PROFILE, options).redactValue(event) as LandoEvent,
      ),
    onSome: (service) =>
      service
        .forProfile(HISTORY_REDACTION_PROFILE, options)
        .pipe(Effect.map((redactor) => redactor.redactValue(event) as LandoEvent)),
  });
};

const makeEventService = (
  config: EventServiceConfig,
  getDispatch: () => EventDispatchRegistration,
): Context.Service.Shape<typeof EventService> => {
  const {
    subscribers,
    queueSubscribers,
    deliveryQueueCapacity,
    history,
    historyCap,
    droppedEvents,
    redaction,
    instrumentation,
  } = config;

  const trackedSubscribe = Effect.gen(function* () {
    const pubsub = yield* PubSub.dropping<LandoEvent>(deliveryQueueCapacity);
    const queue = yield* PubSub.subscribe(pubsub);
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        subscribers.add(pubsub);
      }),
      () =>
        Effect.sync(() => {
          subscribers.delete(pubsub);
        }).pipe(Effect.andThen(PubSub.shutdown(pubsub))),
    );
    return queue;
  });

  const trackedSubscribeQueue = Effect.acquireRelease(
    Queue.dropping<LandoEvent>(deliveryQueueCapacity).pipe(
      Effect.tap((queue) =>
        Effect.sync(() => {
          queueSubscribers.add(queue);
        }),
      ),
    ),
    (queue) =>
      Effect.sync(() => {
        queueSubscribers.delete(queue);
      }).pipe(Effect.andThen(Queue.shutdown(queue))),
  );

  const appendHistory = Effect.fnUntraced(function* (event: LandoEvent): Effect.fn.Return<void> {
    if (historyCap <= 0) return;
    const redacted = yield* redactForHistory(redaction, event);
    yield* Ref.update(history, (events) =>
      events.length < historyCap ? [...events, redacted] : [...events.slice(1), redacted],
    );
  });

  const publishToBus = (event: LandoEvent): Effect.Effect<void> =>
    Effect.sync(() => {
      instrumentation.onPubSubPublish?.();
      let rejectedDeliveries = 0;
      for (const pubsub of subscribers) {
        if (!PubSub.publishUnsafe(pubsub, event)) rejectedDeliveries += 1;
      }
      for (const queue of queueSubscribers) {
        if (!Queue.offerUnsafe(queue, event)) rejectedDeliveries += 1;
      }
      return rejectedDeliveries;
    }).pipe(
      Effect.flatMap((rejectedDeliveries) =>
        rejectedDeliveries === 0
          ? Effect.void
          : Ref.update(droppedEvents, (total) => total + rejectedDeliveries),
      ),
    );

  const waitForMatch = <A>(
    label: string,
    predicate: (event: LandoEvent) => boolean,
    timeout: Duration.Input | undefined,
  ): Effect.Effect<A, EventError> =>
    Effect.scoped(
      Effect.gen(function* () {
        const queue = yield* trackedSubscribe;
        const awaited = Stream.fromSubscription(queue).pipe(
          Stream.filter(predicate),
          Stream.runHead,
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(eventError(label, `Event stream ended before receiving event: ${label}`)),
              onSome: (event) => Effect.succeed(event as A),
            }),
          ),
        );
        return yield* timeout === undefined
          ? awaited
          : awaited.pipe(
              Effect.timeoutOrElse({
                duration: timeout,
                orElse: () => Effect.fail((() => timeoutEventError(label))()),
              }),
            );
      }),
    );

  const service: Context.Service.Shape<typeof EventService> = EventService.of({
    publish: (event) =>
      readEventName(event).pipe(
        Effect.flatMap((eventName) =>
          Effect.suspend(() => {
            const registration = getDispatch();
            const hasManifest = registration.hasSubscribers(eventName);
            if (!hasManifest && subscribers.size === 0 && queueSubscribers.size === 0)
              return appendHistory(event);
            return Effect.sync(() => instrumentation.onPayloadDecode?.()).pipe(
              Effect.andThen(decodeDeliverableEvent(event, eventName)),
              Effect.flatMap((decoded) =>
                publishToBus(decoded).pipe(
                  Effect.andThen(appendHistory(decoded)),
                  Effect.andThen(hasManifest ? registration.dispatch(decoded) : Effect.void),
                ),
              ),
            );
          }).pipe(
            Effect.catchCauseIf(Cause.hasDies, (cause) =>
              Effect.fail(eventError(eventName, `Failed to publish event: ${eventName}`, cause)),
            ),
          ),
        ),
        Effect.asVoid,
      ),
    subscribe: <Name extends string>(name: Name) =>
      Stream.unwrap(
        Effect.map(trackedSubscribe, (queue) =>
          Stream.fromSubscription(queue).pipe(
            Stream.filter((event): event is EventFor<Name> => matchesName(name, event)),
          ),
        ),
      ),
    subscribeQueue: trackedSubscribeQueue,
    waitFor: (name, options) =>
      waitForMatch<EventFor<typeof name>>(
        name,
        (event) => matchesName(name, event) && (options?.filter?.(event as never) ?? true),
        options?.timeout,
      ),
    waitForAny: (specs, options) =>
      waitForMatch("*", (event) => specs.some((spec) => matchesSpec(spec, event)), options?.timeout),
    query: <Name extends string>(name: Name, filter?: (event: EventFor<Name>) => boolean) => {
      if (historyCap <= 0) {
        return Effect.succeed(EMPTY_HISTORY as ReadonlyArray<EventFor<Name>>);
      }
      return Ref.get(history).pipe(
        Effect.map((events) =>
          events.filter(
            (event): event is EventFor<Name> =>
              matchesName(name, event) && (filter?.(event as EventFor<Name>) ?? true),
          ),
        ),
      );
    },
  });

  return service;
};

export const layerWith = (
  historyCap = DEFAULT_HISTORY_CAP,
  instrumentation: EventServiceInstrumentation = {},
  deliveryQueueCapacity = DEFAULT_DELIVERY_QUEUE_CAPACITY,
): Layer.Layer<EventService | EventDispatchControl | EventDeliveryMetrics, never, never> =>
  Layer.unwrap(
    Effect.gen(function* () {
      let registration: EventDispatchRegistration = {
        hasSubscribers: () => false,
        dispatch: () => Effect.void,
      };
      const subscribers = new Set<PubSub.PubSub<LandoEvent>>();
      const queueSubscribers = new Set<Queue.Queue<LandoEvent>>();
      yield* Effect.addFinalizer(() => Effect.forEach(subscribers, PubSub.shutdown, { discard: true }));
      yield* Effect.addFinalizer(() => Effect.forEach(queueSubscribers, Queue.shutdown, { discard: true }));
      const history = yield* Ref.make<ReadonlyArray<LandoEvent>>([]);
      const droppedEvents = yield* Ref.make(0);
      const redaction = yield* Effect.serviceOption(RedactionService);
      const events = Layer.succeed(
        EventService,
        makeEventService(
          {
            subscribers,
            queueSubscribers,
            deliveryQueueCapacity,
            history,
            historyCap,
            droppedEvents,
            redaction,
            instrumentation,
          },
          () => registration,
        ),
      );
      const control = EventDispatchControl.layer({
        install: (next) =>
          Effect.sync(() => {
            registration = next;
          }),
      });
      const metrics = EventDeliveryMetrics.layer({
        snapshot: Ref.get(droppedEvents).pipe(
          Effect.map(
            (droppedEvents): EventDeliveryMetricsSnapshot => ({
              capacity: deliveryQueueCapacity,
              droppedEvents,
            }),
          ),
        ),
      });
      return Layer.mergeAll(events, control, metrics);
    }),
  );

export const layerRuntimeWithConfig = (
  deliveryQueueCapacity?: number,
): Layer.Layer<EventService | EventDispatchControl | EventDeliveryMetrics, never, ConfigService> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const config = yield* ConfigService;
      const eventConfig = yield* config.get("events").pipe(Effect.orElseSucceed(() => undefined));
      return layerWith(
        DEFAULT_HISTORY_CAP,
        {},
        deliveryQueueCapacity ?? eventConfig?.deliveryQueueCapacity ?? DEFAULT_DELIVERY_QUEUE_CAPACITY,
      );
    }),
  );

export const layerRuntime = layerWith();
export const layer: Layer.Layer<EventService, never, never> = layerRuntime;
