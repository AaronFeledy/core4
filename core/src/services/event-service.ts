import { Cause, Context, type Duration, Effect, Layer, Option, PubSub, Ref, Schema, Stream } from "effect";

import { EventError } from "@lando/sdk/errors";
import { LandoEvent as LandoEventSchema } from "@lando/sdk/events";
import { type EventFor, EventService, type EventWaitSpec, type LandoEvent } from "@lando/sdk/services";

import {
  type RedactionForProfileOptions,
  RedactionService,
  createStandaloneRedactor,
} from "../redaction/service.ts";

const DEFAULT_HISTORY_CAP = 64;
const EMPTY_HISTORY: ReadonlyArray<LandoEvent> = Object.freeze([]);

const eventError = (event: string, message: string, cause?: unknown): EventError =>
  new EventError({ message, event, ...(cause === undefined ? {} : { cause }) });

const timeoutEventError = (event: string): EventError =>
  new EventError({ message: `Timed out waiting for event: ${event}`, event, reason: "timeout" });

const readEventName = (event: LandoEvent): Effect.Effect<string, EventError> =>
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

const decodeDeliverableEvent = (
  event: LandoEvent,
  eventName: string,
): Effect.Effect<LandoEvent, EventError> =>
  Schema.encodeUnknown(LandoEventSchema)(event, { onExcessProperty: "error" }).pipe(
    Effect.flatMap((encoded) =>
      Schema.decodeUnknown(LandoEventSchema)(encoded, { onExcessProperty: "error" }),
    ),
    Effect.mapError((cause) => eventError(eventName, `Event failed schema validation: ${eventName}`, cause)),
    Effect.catchSomeCause((cause) =>
      Cause.isDie(cause)
        ? Option.some(
            Effect.fail(eventError(eventName, `Event failed schema validation: ${eventName}`, cause)),
          )
        : Option.none(),
    ),
  );

const matchesName = (name: string, event: LandoEvent): boolean => name === "*" || event._tag === name;

const matchesSpec = (spec: EventWaitSpec, event: LandoEvent): boolean => {
  if (!matchesName(spec.name, event)) return false;
  return spec.filter?.(event as never) ?? true;
};

type EventServiceConfig = {
  readonly pubsub: PubSub.PubSub<LandoEvent>;
  readonly history: Ref.Ref<ReadonlyArray<LandoEvent>>;
  readonly historyCap: number;
  readonly redaction: Option.Option<Context.Tag.Service<typeof RedactionService>>;
  readonly instrumentation: EventServiceInstrumentation;
};

export interface EventServiceInstrumentation {
  readonly onPubSubPublish?: () => void;
}

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
  const { pubsub, history, historyCap, redaction, instrumentation } = config;

  let activeConsumers = 0;
  const trackedSubscribe = Effect.acquireRelease(
    Effect.sync(() => {
      activeConsumers += 1;
    }),
    () =>
      Effect.sync(() => {
        activeConsumers -= 1;
      }),
  ).pipe(Effect.zipRight(PubSub.subscribe(pubsub)));

  const appendHistory = (event: LandoEvent): Effect.Effect<void> => {
    if (historyCap <= 0) return Effect.void;
    return Effect.gen(function* () {
      const redacted = yield* redactForHistory(redaction, event);
      yield* Ref.update(history, (events) =>
        events.length < historyCap ? [...events, redacted] : [...events.slice(1), redacted],
      );
    });
  };

  const publishToBus = (event: LandoEvent): Effect.Effect<boolean> =>
    Effect.sync(() => instrumentation.onPubSubPublish?.()).pipe(
      Effect.zipRight(PubSub.publish(pubsub, event)),
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
            if (!hasManifest && activeConsumers === 0) return appendHistory(event);
            return decodeDeliverableEvent(event, eventName).pipe(
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
): Layer.Layer<EventService | EventDispatchControl, never, never> =>
  Layer.unwrapScoped(
    Effect.gen(function* () {
      let registration: EventDispatchRegistration = {
        hasSubscribers: () => false,
        dispatch: () => Effect.void,
      };
      const pubsub = yield* PubSub.unbounded<LandoEvent>();
      yield* Effect.addFinalizer(() => PubSub.shutdown(pubsub));
      const history = yield* Ref.make<ReadonlyArray<LandoEvent>>([]);
      const redaction = yield* Effect.serviceOption(RedactionService);
      const events = Layer.succeed(
        EventService,
        makeEventService({ pubsub, history, historyCap, redaction, instrumentation }, () => registration),
      );
      const control = Layer.succeed(EventDispatchControl, {
        install: (next) =>
          Effect.sync(() => {
            registration = next;
          }),
      });
      return Layer.merge(events, control);
    }),
  );

export const EventRuntimeLive = makeEventServiceLive();
export const EventServiceLive: Layer.Layer<EventService, never, never> = EventRuntimeLive;
