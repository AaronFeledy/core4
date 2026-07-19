import { describe, expect, test } from "bun:test";

import { DateTime, Effect, Exit, Fiber, Schema, Stream } from "effect";

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
