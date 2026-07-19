import { describe, expect, test } from "bun:test";

import { DateTime, Effect, Exit, Fiber, Queue, Schema, Scope, Stream } from "effect";

import { EventError } from "@lando/core/errors";
import { EventService } from "@lando/core/services";
import { PostAppStartEvent, PreAppStartEvent } from "@lando/sdk/events";
import { EventServiceLive } from "../../src/services/event-service.ts";
import { EventDispatchControl, EventRuntimeLive } from "../../src/services/event-service.ts";

const appRefFixture = {
  kind: "user",
  id: "myapp",
  root: "/srv/apps/myapp",
} as const;

const preAppStartInput: unknown = {
  _tag: "pre-app-start",
  eventName: "pre-app-start",
  appRef: appRefFixture,
  providerId: "lando",
  timestamp: DateTime.formatIso(DateTime.unsafeMake("2026-05-11T07:30:00Z")),
};

const postAppStartInput: unknown = {
  _tag: "post-app-start",
  eventName: "post-app-start",
  appRef: appRefFixture,
  providerId: "lando",
  timestamp: DateTime.formatIso(DateTime.unsafeMake("2026-05-11T07:30:00Z")),
};

const preAppStartEvent = Schema.decodeUnknownSync(PreAppStartEvent)(preAppStartInput);
const postAppStartEvent = Schema.decodeUnknownSync(PostAppStartEvent)(postAppStartInput);

describe("EventServiceLive", () => {
  test("publishes lifecycle events to subscribers in order", async () => {
    const received = await Effect.runPromise(
      Effect.flatMap(EventService, (eventService) =>
        Effect.gen(function* () {
          const subscriber = yield* eventService
            .subscribe("*")
            .pipe(Stream.take(2), Stream.runCollect, Effect.fork);
          yield* Effect.sleep("10 millis");
          yield* eventService.publish(preAppStartEvent);
          yield* eventService.publish(postAppStartEvent);
          return yield* Fiber.join(subscriber);
        }),
      ).pipe(Effect.provide(EventServiceLive)),
    );

    expect(Array.from(received)).toEqual([preAppStartEvent, postAppStartEvent]);
  });

  test("fans out events to every active subscriber", async () => {
    const [first, second] = await Effect.runPromise(
      Effect.flatMap(EventService, (eventService) =>
        Effect.gen(function* () {
          const firstSubscriber = yield* eventService
            .subscribe("pre-app-start")
            .pipe(Stream.take(1), Stream.runCollect, Effect.fork);
          const secondSubscriber = yield* eventService
            .subscribe("pre-app-start")
            .pipe(Stream.take(1), Stream.runCollect, Effect.fork);
          yield* Effect.sleep("10 millis");
          yield* eventService.publish(preAppStartEvent);
          return [yield* Fiber.join(firstSubscriber), yield* Fiber.join(secondSubscriber)] as const;
        }),
      ).pipe(Effect.provide(EventServiceLive)),
    );

    expect(Array.from(first)).toEqual([preAppStartEvent]);
    expect(Array.from(second)).toEqual([preAppStartEvent]);
  });

  test("a failing subscriber does not abort publish or other subscribers", async () => {
    const result = await Effect.runPromise(
      Effect.flatMap(EventService, (eventService) =>
        Effect.gen(function* () {
          const failingSubscriber = yield* eventService.subscribe("pre-app-start").pipe(
            Stream.take(1),
            Stream.runForEach(() => Effect.fail(new EventError({ message: "subscriber failed" }))),
            Effect.exit,
            Effect.fork,
          );
          const healthySubscriber = yield* eventService
            .subscribe("pre-app-start")
            .pipe(Stream.take(1), Stream.runCollect, Effect.fork);
          yield* Effect.sleep("10 millis");
          yield* eventService.publish(preAppStartEvent);
          return {
            failingExit: yield* Fiber.join(failingSubscriber),
            healthyEvents: yield* Fiber.join(healthySubscriber),
          };
        }),
      ).pipe(Effect.provide(EventServiceLive)),
    );

    expect(Exit.isFailure(result.failingExit)).toBe(true);
    expect(Array.from(result.healthyEvents)).toEqual([preAppStartEvent]);
  });

  test("waitFor resolves the first matching event", async () => {
    const received = await Effect.runPromise(
      Effect.flatMap(EventService, (eventService) =>
        Effect.gen(function* () {
          const waiter = yield* eventService
            .waitFor("pre-app-start", { filter: (event) => event._tag === "pre-app-start" })
            .pipe(Effect.fork);
          yield* Effect.sleep("10 millis");
          yield* eventService.publish(postAppStartEvent);
          yield* eventService.publish(preAppStartEvent);
          return yield* Fiber.join(waiter);
        }),
      ).pipe(Effect.provide(EventServiceLive)),
    );

    expect(received).toEqual(preAppStartEvent);
  });

  test("subscriptions are scope-bound", async () => {
    const exit = await Effect.runPromise(
      Effect.flatMap(EventService, (eventService) =>
        Effect.gen(function* () {
          const scopedFiber = yield* Effect.scoped(
            eventService
              .subscribe("pre-app-start")
              .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped),
          );
          yield* eventService.publish(preAppStartEvent);
          return yield* Fiber.await(scopedFiber);
        }),
      ).pipe(Effect.provide(EventServiceLive)),
    );

    expect(Exit.isInterrupted(exit)).toBe(true);
  });

  test("awaits the dispatcher attached to the same event-service instance", async () => {
    // Given: an internal dispatcher installed on one event runtime.
    const dispatched: string[] = [];

    // When: the public EventService publishes an event through that runtime.
    await Effect.runPromise(
      Effect.gen(function* () {
        const control = yield* EventDispatchControl;
        const events = yield* EventService;
        yield* control.install({
          hasSubscribers: () => true,
          dispatch: (event) =>
            Effect.sync(() => {
              dispatched.push(event._tag);
            }),
        });
        yield* events.publish(preAppStartEvent);
      }).pipe(Effect.provide(EventRuntimeLive)),
    );

    // Then: publish does not complete before dispatcher delivery.
    expect(dispatched).toEqual(["pre-app-start"]);
  });

  test("subscriber membership fast path skips dispatch without suppressing the public event bus", async () => {
    // Given: a closed plugin-subscriber membership predicate with no match.
    let dispatches = 0;

    // When: an ordinary public event is published.
    const retained = await Effect.runPromise(
      Effect.gen(function* () {
        const control = yield* EventDispatchControl;
        const events = yield* EventService;
        yield* control.install({
          hasSubscribers: () => false,
          dispatch: () =>
            Effect.sync(() => {
              dispatches += 1;
            }),
        });
        yield* events.publish(preAppStartEvent);
        return yield* events.query("pre-app-start");
      }).pipe(Effect.provide(EventRuntimeLive)),
    );

    // Then: plugin dispatch is skipped while history/public consumers still receive the event.
    expect(dispatches).toBe(0);
    expect(retained).toEqual([preAppStartEvent]);
  });
});

const invalidKnownEvent = { _tag: "download-progress", bytes: 1 };
const unknownTagEvent = { _tag: "not-a-real-lando-event", value: 1 };

describe("EventServiceLive publish contract", () => {
  test("delivering path rejects an invalid payload before the bus, history, and dispatch", async () => {
    // Given: a manifest subscriber is registered for the event tag.
    let dispatches = 0;
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const control = yield* EventDispatchControl;
        const events = yield* EventService;
        yield* control.install({
          hasSubscribers: () => true,
          dispatch: () =>
            Effect.sync(() => {
              dispatches += 1;
            }),
        });
        // When: an event whose payload fails schema validation is published.
        const exit = yield* events.publish(invalidKnownEvent).pipe(Effect.exit);
        const recorded = yield* events.query("*");
        return { exit, recorded };
      }).pipe(Effect.provide(EventRuntimeLive)),
    );

    // Then: publish fails with a tagged EventError naming the event and nothing is delivered or recorded.
    expect(Exit.isFailure(outcome.exit)).toBe(true);
    if (Exit.isFailure(outcome.exit)) {
      const error = outcome.exit.cause;
      expect(String(JSON.stringify(error))).toContain("EventError");
    }
    expect(dispatches).toBe(0);
    expect(outcome.recorded).toEqual([]);
  });

  test("delivering path validation triggers for an active dynamic consumer with no manifest subscriber", async () => {
    const outcome = await Effect.runPromise(
      Effect.flatMap(EventService, (events) =>
        Effect.scoped(
          Effect.gen(function* () {
            // Given: an eagerly acquired dynamic consumer and no manifest subscriber.
            yield* events.subscribeQueue;
            // When: an unknown-tag event is published while that consumer is active.
            const exit = yield* events.publish(unknownTagEvent).pipe(Effect.exit);
            const recorded = yield* events.query("*");
            return { exit, recorded };
          }),
        ),
      ).pipe(Effect.provide(EventServiceLive)),
    );

    // Then: the dynamic consumer alone forces validation and the event never reaches history.
    expect(Exit.isFailure(outcome.exit)).toBe(true);
    expect(outcome.recorded).toEqual([]);
  });

  test("zero-subscriber short-circuit skips validation while history append is unchanged", async () => {
    // Given: neither a manifest subscriber nor an active dynamic consumer.
    const recorded = await Effect.runPromise(
      Effect.flatMap(EventService, (events) =>
        Effect.gen(function* () {
          // When: an unvalidated event is published with nobody listening.
          yield* events.publish(invalidKnownEvent);
          return yield* events.query("*");
        }),
      ).pipe(Effect.provide(EventServiceLive)),
    );

    // Then: the short-circuit performs no validation, yet the history append still runs.
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?._tag).toBe("download-progress");
  });

  test("a released dynamic consumer returns publish to the short-circuit path", async () => {
    const outcome = await Effect.runPromise(
      Effect.flatMap(EventService, (events) =>
        Effect.gen(function* () {
          const scope = yield* Scope.make();
          // Given: a dynamic consumer held open in an explicit scope.
          yield* events.subscribeQueue.pipe(Scope.extend(scope));
          const whileActive = yield* events.publish(invalidKnownEvent).pipe(Effect.exit);
          // When: the last active consumer releases.
          yield* Scope.close(scope, Exit.void);
          const afterRelease = yield* events.publish(invalidKnownEvent).pipe(Effect.exit);
          return { whileActive, afterRelease };
        }),
      ).pipe(Effect.provide(EventServiceLive)),
    );

    // Then: validation applies while a consumer is active and is skipped once it releases.
    expect(Exit.isFailure(outcome.whileActive)).toBe(true);
    expect(Exit.isSuccess(outcome.afterRelease)).toBe(true);
  });

  test("a consumer registered before publish still receives matching valid events", async () => {
    const received = await Effect.runPromise(
      Effect.flatMap(EventService, (events) =>
        Effect.scoped(
          Effect.gen(function* () {
            // Given: an eagerly acquired consumer registered before the producer runs.
            const queue = yield* events.subscribeQueue;
            // When: a schema-valid event is published.
            yield* events.publish(preAppStartEvent);
            return yield* Queue.take(queue);
          }),
        ),
      ).pipe(Effect.provide(EventServiceLive)),
    );

    // Then: the pre-registered consumer receives the delivered event.
    expect(received).toEqual(preAppStartEvent);
  });
});
