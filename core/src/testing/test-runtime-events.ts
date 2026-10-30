import { createStandaloneRedactor } from "@lando/redaction/service";
import { EventError } from "@lando/sdk/errors";
import {
  type EventFor,
  EventService,
  type EventWaitAnyOptions,
  type EventWaitSpecs,
  type LandoEvent,
} from "@lando/sdk/services";
import { Cause, type Duration, Effect, Option, PubSub, Queue, Stream } from "effect";

const eventError = (event: string, message: string, cause?: unknown): EventError =>
  new EventError({
    message,
    event,
    ...(cause === undefined ? {} : { cause }),
    remediation: event
      ? `Fix the handler or emitter for event \`${event}\`, then re-run the operation that publishes it.`
      : "Fix the failing event handler or emitter, then re-run the operation that publishes it.",
  });

export const makeTestEventService = (recorded: LandoEvent[], deliveryCapacity = 64) => {
  const pubsub = Effect.runSync(PubSub.unbounded<LandoEvent>());
  const queues = new Set<Queue.Queue<LandoEvent>>();
  const historyQueues = new Map<Queue.Queue<LandoEvent>, { dropped: number }>();
  let history: ReadonlyArray<LandoEvent> = Object.freeze([]);
  const redact = (event: LandoEvent): LandoEvent =>
    Object.assign(
      { _tag: event._tag },
      createStandaloneRedactor("secrets", { sourceEnv: process.env }).redactValue(event),
      { timestamp: event.timestamp },
    );
  const matches = <Name extends string>(name: Name, event: LandoEvent): event is EventFor<Name> =>
    name === "*" || event._tag === name;
  const waitForMatch = Effect.fnUntraced(function* <A extends LandoEvent>(
    label: string,
    predicate: (event: LandoEvent) => event is A,
    timeout: Duration.Input | undefined,
  ): Effect.fn.Return<A, EventError, import("effect").Scope.Scope> {
    const queue = yield* PubSub.subscribe(pubsub);
    const awaited = Stream.fromSubscription(queue).pipe(
      Stream.filter(predicate),
      Stream.runHead,
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(eventError(label, `Event stream ended before receiving event: ${label}`)),
          onSome: (event) => Effect.succeed(event),
        }),
      ),
    );
    return yield* timeout === undefined
      ? awaited
      : awaited.pipe(
          Effect.timeoutOrElse({
            duration: timeout,
            orElse: () =>
              Effect.fail(
                new EventError({
                  message: `Timed out waiting for event: ${label}`,
                  event: label,
                  reason: "timeout",
                  remediation: `Increase the wait for event \`${label}\`, or fix whatever should emit that event before timing out.`,
                }),
              ),
          }),
        );
  }, Effect.scoped);
  return EventService.of({
    publish: (event) =>
      Effect.sync(() => {
        const safe = redact(event);
        recorded.push(event);
        history = Object.freeze([...history.slice(-63), safe]);
        for (const queue of queues) Queue.offerUnsafe(queue, event);
        for (const [queue, counter] of historyQueues) {
          if (!Queue.offerUnsafe(queue, safe)) counter.dropped += 1;
        }
        PubSub.publishUnsafe(pubsub, event);
      }).pipe(
        Effect.catchCauseIf(Cause.hasDies, (cause) =>
          Effect.fail(eventError(event._tag, `Failed to publish event: ${event._tag}`, cause)),
        ),
      ),
    subscribe: <Name extends string>(name: Name) =>
      Stream.fromPubSub(pubsub).pipe(Stream.filter((event): event is EventFor<Name> => matches(name, event))),
    subscribeQueue: Effect.acquireRelease(
      Queue.unbounded<LandoEvent>().pipe(
        Effect.tap((queue) =>
          Effect.sync(() => {
            queues.add(queue);
          }),
        ),
      ),
      (queue) =>
        Effect.sync(() => {
          queues.delete(queue);
        }).pipe(Effect.andThen(Queue.shutdown(queue)), Effect.asVoid),
    ),
    subscribeWithHistory: (options) =>
      Effect.acquireRelease(
        Queue.dropping<LandoEvent>(options?.capacity ?? deliveryCapacity).pipe(
          Effect.flatMap((queue) =>
            Effect.sync(() => {
              const counter = { dropped: 0 };
              historyQueues.set(queue, counter);
              return {
                history,
                queue,
                dropped: Effect.sync(() => counter.dropped),
                stop: Effect.sync(() => {
                  historyQueues.delete(queue);
                }),
              };
            }),
          ),
        ),
        (subscription) => subscription.stop.pipe(Effect.andThen(Queue.shutdown(subscription.queue))),
      ),
    waitFor: (name, options) =>
      waitForMatch<EventFor<typeof name>>(
        name,
        (event): event is EventFor<typeof name> => matches(name, event) && (options?.filter?.(event) ?? true),
        options?.timeout,
      ),
    waitForAny: <const Names extends readonly string[]>(
      specs: EventWaitSpecs<Names>,
      options?: EventWaitAnyOptions,
    ) =>
      waitForMatch<EventFor<Names[number] & string>>(
        "*",
        (event): event is EventFor<Names[number] & string> =>
          specs.some((spec) => matches(spec.name, event) && (spec.filter?.(event) ?? true)),
        options?.timeout,
      ),
    query: <Name extends string>(name: Name, filter?: (event: EventFor<Name>) => boolean) =>
      Effect.sync(() =>
        history
          .map(redact)
          .filter((event): event is EventFor<Name> => matches(name, event) && (filter?.(event) ?? true)),
      ),
  });
};
