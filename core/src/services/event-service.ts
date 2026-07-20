import { Cause, Context, type Duration, Effect, Layer, Option, PubSub, Ref, Stream } from "effect";

import type { ConfigError, EventError } from "@lando/sdk/errors";
import { ConfigService, type EventFor, EventService, type LandoEvent } from "@lando/sdk/services";

import {
  type RedactionForProfileOptions,
  RedactionService,
  createStandaloneRedactor,
} from "../redaction/service.ts";
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
  readonly deliveryQueueCapacity: number;
  readonly history: Ref.Ref<ReadonlyArray<LandoEvent>>;
  readonly historyCap: number;
  readonly droppedEvents: Ref.Ref<number>;
  readonly redaction: Option.Option<Context.Tag.Service<typeof RedactionService>>;
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

export class EventDeliveryMetrics extends Context.Tag("@lando/core/EventDeliveryMetrics")<
  EventDeliveryMetrics,
  { readonly snapshot: Effect.Effect<EventDeliveryMetricsSnapshot> }
>() {}

export type EventDispatcher = (event: LandoEvent) => Effect.Effect<void, EventError>;
export type EventDispatchRegistration = {
  readonly hasSubscribers: (eventName: string) => boolean;
  readonly dispatch: EventDispatcher;
};

export class EventDispatchControl extends Context.Tag("@lando/core/EventDispatchControl")<
  EventDispatchControl,
  { readonly install: (registration: EventDispatchRegistration) => Effect.Effect<void> }
>() {}

const HISTORY_REDACTION_PROFILE = "secrets" as const;

const historyRedactionOptions = (): RedactionForProfileOptions => ({ sourceEnv: process.env });

const redactForHistory = (
  redaction: Option.Option<Context.Tag.Service<typeof RedactionService>>,
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
): Context.Tag.Service<typeof EventService> => {
  const {
    subscribers,
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
        }).pipe(Effect.zipRight(PubSub.shutdown(pubsub))),
    );
    return queue;
  });

  const appendHistory = (event: LandoEvent): Effect.Effect<void> => {
    if (historyCap <= 0) return Effect.void;
    return Effect.gen(function* () {
      const redacted = yield* redactForHistory(redaction, event);
      yield* Ref.update(history, (events) =>
        events.length < historyCap ? [...events, redacted] : [...events.slice(1), redacted],
      );
    });
  };

  const publishToBus = (event: LandoEvent): Effect.Effect<void> =>
    Effect.sync(() => {
      instrumentation.onPubSubPublish?.();
      let rejectedDeliveries = 0;
      for (const pubsub of subscribers) {
        if (!pubsub.unsafeOffer(event)) rejectedDeliveries += 1;
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
    timeout: Duration.DurationInput | undefined,
  ): Effect.Effect<A, EventError> =>
    Effect.scoped(
      Effect.gen(function* () {
        const queue = yield* trackedSubscribe;
        const awaited = Stream.fromQueue(queue).pipe(
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
              Effect.timeoutFail({ duration: timeout, onTimeout: () => timeoutEventError(label) }),
            );
      }),
    );

  const service: Context.Tag.Service<typeof EventService> = {
    publish: (event) =>
      readEventName(event).pipe(
        Effect.flatMap((eventName) =>
          Effect.suspend(() => {
            const registration = getDispatch();
            const hasManifest = registration.hasSubscribers(eventName);
            if (!hasManifest && subscribers.size === 0) return appendHistory(event);
            return Effect.sync(() => instrumentation.onPayloadDecode?.()).pipe(
              Effect.zipRight(decodeDeliverableEvent(event, eventName)),
              Effect.flatMap((decoded) =>
                publishToBus(decoded).pipe(
                  Effect.zipRight(appendHistory(decoded)),
                  Effect.zipRight(hasManifest ? registration.dispatch(decoded) : Effect.void),
                ),
              ),
            );
          }).pipe(
            Effect.catchSomeCause((cause) =>
              Cause.isDie(cause)
                ? Option.some(
                    Effect.fail(eventError(eventName, `Failed to publish event: ${eventName}`, cause)),
                  )
                : Option.none(),
            ),
          ),
        ),
        Effect.asVoid,
      ),
    subscribe: <Name extends string>(name: Name) =>
      Stream.unwrapScoped(
        Effect.map(trackedSubscribe, (queue) =>
          Stream.fromQueue(queue).pipe(
            Stream.filter((event): event is EventFor<Name> => matchesName(name, event)),
          ),
        ),
      ),
    subscribeQueue: trackedSubscribe,
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
  };

  return service;
};

export const makeEventServiceLive = (
  historyCap = DEFAULT_HISTORY_CAP,
  instrumentation: EventServiceInstrumentation = {},
  deliveryQueueCapacity = DEFAULT_DELIVERY_QUEUE_CAPACITY,
): Layer.Layer<EventService | EventDispatchControl | EventDeliveryMetrics, never, never> =>
  Layer.unwrapScoped(
    Effect.gen(function* () {
      let registration: EventDispatchRegistration = {
        hasSubscribers: () => false,
        dispatch: () => Effect.void,
      };
      const subscribers = new Set<PubSub.PubSub<LandoEvent>>();
      yield* Effect.addFinalizer(() => Effect.forEach(subscribers, PubSub.shutdown, { discard: true }));
      const history = yield* Ref.make<ReadonlyArray<LandoEvent>>([]);
      const droppedEvents = yield* Ref.make(0);
      const redaction = yield* Effect.serviceOption(RedactionService);
      const events = Layer.succeed(
        EventService,
        makeEventService(
          {
            subscribers,
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
      const control = Layer.succeed(EventDispatchControl, {
        install: (next) =>
          Effect.sync(() => {
            registration = next;
          }),
      });
      const metrics = Layer.succeed(EventDeliveryMetrics, {
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

export const makeEventRuntimeLive = (
  deliveryQueueCapacity?: number,
): Layer.Layer<EventService | EventDispatchControl | EventDeliveryMetrics, ConfigError, ConfigService> =>
  Layer.unwrapScoped(
    Effect.gen(function* () {
      const config = yield* ConfigService;
      const eventConfig = yield* config.get("events");
      return makeEventServiceLive(
        DEFAULT_HISTORY_CAP,
        {},
        deliveryQueueCapacity ?? eventConfig?.deliveryQueueCapacity ?? DEFAULT_DELIVERY_QUEUE_CAPACITY,
      );
    }),
  );

export const EventRuntimeLive = makeEventServiceLive();
export const EventServiceLive: Layer.Layer<EventService, never, never> = EventRuntimeLive;
