import { describe, expect, test } from "bun:test";

import {
  Cause,
  DateTime,
  Duration,
  Effect,
  Exit,
  Fiber,
  Option,
  Schema,
  TestClock,
  TestContext,
} from "effect";

import { EventService } from "@lando/core/services";
import { PostAppStartEvent, PreAppStartEvent } from "@lando/sdk/events";
import { EventServiceLive } from "../../src/services/event-service.ts";
import { waitForEvent } from "../../src/testing/events.ts";

const appRefFixture = {
  kind: "user",
  id: "myapp",
  root: "/srv/apps/myapp",
} as const;

const otherAppRefFixture = {
  kind: "user",
  id: "otherapp",
  root: "/srv/apps/otherapp",
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

const filteredOutPreAppStartInput: unknown = {
  _tag: "pre-app-start",
  eventName: "pre-app-start",
  appRef: otherAppRefFixture,
  providerId: "lando",
  timestamp: DateTime.formatIso(DateTime.unsafeMake("2026-05-11T07:30:00Z")),
};

const preAppStartEvent = Schema.decodeUnknownSync(PreAppStartEvent)(preAppStartInput);
const postAppStartEvent = Schema.decodeUnknownSync(PostAppStartEvent)(postAppStartInput);
const filteredOutPreAppStartEvent = Schema.decodeUnknownSync(PreAppStartEvent)(filteredOutPreAppStartInput);

describe("waitForEvent", () => {
  test("resolves with the typed payload when a matching event is published", async () => {
    const received = await Effect.runPromise(
      Effect.gen(function* () {
        const waiter = yield* waitForEvent("pre-app-start", {
          filter: (event) => event.appRef.id === "myapp",
        }).pipe(Effect.fork);
        yield* Effect.sleep("10 millis");
        yield* Effect.flatMap(EventService, (events) => events.publish(postAppStartEvent));
        yield* Effect.flatMap(EventService, (events) => events.publish(filteredOutPreAppStartEvent));
        yield* Effect.flatMap(EventService, (events) => events.publish(preAppStartEvent));
        return yield* Fiber.join(waiter);
      }).pipe(Effect.provide(EventServiceLive)),
    );

    expect(received).toEqual(preAppStartEvent);
    expect(received._tag).toBe("pre-app-start");
    expect(String(received.providerId)).toBe("lando");
    expect(received.appRef.id).toBe("myapp");
  });

  test("returns the same payload as EventService.waitFor for the same event", async () => {
    const [viaHelper, viaService] = await Effect.runPromise(
      Effect.gen(function* () {
        const helperWaiter = yield* waitForEvent("pre-app-start").pipe(Effect.fork);
        const serviceWaiter = yield* Effect.flatMap(EventService, (events) =>
          events.waitFor("pre-app-start"),
        ).pipe(Effect.fork);
        yield* Effect.sleep("10 millis");
        yield* Effect.flatMap(EventService, (events) => events.publish(preAppStartEvent));
        return [yield* Fiber.join(helperWaiter), yield* Fiber.join(serviceWaiter)] as const;
      }).pipe(Effect.provide(EventServiceLive)),
    );

    expect(viaHelper).toEqual(viaService);
    expect(viaHelper).toEqual(preAppStartEvent);
  });

  test("fails with the EventError timeout contract when its deadline elapses", async () => {
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const waiter = yield* waitForEvent("download-progress", {
          timeout: Duration.seconds(2),
        }).pipe(Effect.exit, Effect.fork);
        yield* TestClock.adjust("3 seconds");
        return yield* Fiber.join(waiter);
      }).pipe(Effect.provide(EventServiceLive), Effect.provide(TestContext.TestContext)),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = Cause.failureOption(exit.cause);
      expect(error._tag).toBe("Some");
      if (error._tag === "Some") {
        expect(error.value._tag).toBe("EventError");
        expect(error.value.reason).toBe("timeout");
        expect(error.value.event).toBe("download-progress");
      }
    }
  });

  test("waits indefinitely when no timeout is supplied", async () => {
    const polled = await Effect.runPromise(
      Effect.gen(function* () {
        const waiter = yield* waitForEvent("pre-app-start").pipe(Effect.fork);
        // Unlike expectEvent, waitForEvent injects no default timeout: even after
        // a long virtual delay with nothing published, the fiber is still pending.
        yield* TestClock.adjust("1 hour");
        const result = yield* Fiber.poll(waiter);
        yield* Fiber.interrupt(waiter);
        return result;
      }).pipe(Effect.provide(EventServiceLive), Effect.provide(TestContext.TestContext)),
    );

    expect(Option.isNone(polled)).toBe(true);
  });
});
