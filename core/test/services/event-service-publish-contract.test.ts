import { describe, expect, test } from "bun:test";

import { Cause, DateTime, Effect, Exit, Option, Queue, Schema, Scope } from "effect";

import { EventError } from "@lando/core/errors";
import { EventService } from "@lando/core/services";
import { PreAppStartEvent } from "@lando/sdk/events";

import {
  EventDispatchControl,
  EventRuntimeLive,
  EventServiceLive,
  makeEventServiceLive,
} from "../../src/services/event-service.ts";

const preAppStartEvent = Schema.decodeUnknownSync(PreAppStartEvent)({
  _tag: "pre-app-start",
  eventName: "pre-app-start",
  appRef: { kind: "user", id: "myapp", root: "/srv/apps/myapp" },
  providerId: "lando",
  timestamp: DateTime.formatIso(DateTime.unsafeMake("2026-05-11T07:30:00Z")),
});
const invalidKnownEvent = { _tag: "download-progress", bytes: 1 };
const unknownTagEvent = { _tag: "not-a-real-lando-event", value: 1 };

describe("EventServiceLive publish contract", () => {
  test("malformed runtime input fails with EventError instead of escaping as a defect", async () => {
    const hostileEvent = {
      ...preAppStartEvent,
      get _tag(): never {
        throw new TypeError("hostile event tag getter");
      },
    };

    const exit = await Effect.runPromise(
      Effect.flatMap(EventService, (events) => events.publish(hostileEvent).pipe(Effect.exit)).pipe(
        Effect.provide(EventServiceLive),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(Option.isSome(failure)).toBe(true);
      if (Option.isSome(failure)) expect(failure.value).toBeInstanceOf(EventError);
    }
  });

  test("null runtime input fails with EventError instead of escaping as a defect", async () => {
    const exit = await Effect.runPromise(
      Effect.flatMap(EventService, (events) => events.publish(null as never).pipe(Effect.exit)).pipe(
        Effect.provide(EventServiceLive),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(Option.isSome(failure)).toBe(true);
      if (Option.isSome(failure)) expect(failure.value).toBeInstanceOf(EventError);
    }
  });

  test("delivering path rejects excess properties before queue and history retention", async () => {
    const eventWithExcessData = { ...preAppStartEvent, excess: "x".repeat(1024 * 1024) };

    const outcome = await Effect.runPromise(
      Effect.flatMap(EventService, (events) =>
        Effect.scoped(
          Effect.gen(function* () {
            const queue = yield* events.subscribeQueue;
            const exit = yield* events.publish(eventWithExcessData).pipe(Effect.exit);
            const queued = yield* Queue.poll(queue);
            const recorded = yield* events.query("*");
            return { exit, queued, recorded };
          }),
        ),
      ).pipe(Effect.provide(EventServiceLive)),
    );

    expect(Exit.isFailure(outcome.exit)).toBe(true);
    expect(Option.isNone(outcome.queued)).toBe(true);
    expect(outcome.recorded).toEqual([]);
  });

  test("delivering path rejects an invalid payload before the bus, history, and dispatch", async () => {
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
        const exit = yield* events.publish(invalidKnownEvent).pipe(Effect.exit);
        const recorded = yield* events.query("*");
        return { exit, recorded };
      }).pipe(Effect.provide(EventRuntimeLive)),
    );

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
            yield* events.subscribeQueue;
            const exit = yield* events.publish(unknownTagEvent).pipe(Effect.exit);
            const recorded = yield* events.query("*");
            return { exit, recorded };
          }),
        ),
      ).pipe(Effect.provide(EventServiceLive)),
    );

    expect(Exit.isFailure(outcome.exit)).toBe(true);
    expect(outcome.recorded).toEqual([]);
  });

  test("zero-subscriber short-circuit skips validation while history append is unchanged", async () => {
    const recorded = await Effect.runPromise(
      Effect.flatMap(EventService, (events) =>
        Effect.gen(function* () {
          yield* events.publish(invalidKnownEvent);
          return yield* events.query("*");
        }),
      ).pipe(Effect.provide(EventServiceLive)),
    );

    expect(recorded).toHaveLength(1);
    expect(recorded[0]?._tag).toBe("download-progress");
  });

  test("zero-subscriber short-circuit does not invoke PubSub publish", async () => {
    let publishCalls = 0;
    const layer = makeEventServiceLive(64, {
      onPubSubPublish: () => {
        publishCalls += 1;
      },
    });

    await Effect.runPromise(
      Effect.flatMap(EventService, (events) => events.publish(invalidKnownEvent)).pipe(Effect.provide(layer)),
    );

    expect(publishCalls).toBe(0);
  });

  test("PubSub instrumentation observes the delivering path", async () => {
    let publishCalls = 0;
    const layer = makeEventServiceLive(64, {
      onPubSubPublish: () => {
        publishCalls += 1;
      },
    });

    await Effect.runPromise(
      Effect.flatMap(EventService, (events) =>
        Effect.scoped(
          Effect.gen(function* () {
            yield* events.subscribeQueue;
            yield* events.publish(preAppStartEvent);
          }),
        ),
      ).pipe(Effect.provide(layer)),
    );

    expect(publishCalls).toBe(1);
  });

  test("a released dynamic consumer returns publish to the short-circuit path", async () => {
    const outcome = await Effect.runPromise(
      Effect.flatMap(EventService, (events) =>
        Effect.gen(function* () {
          const scope = yield* Scope.make();
          yield* events.subscribeQueue.pipe(Scope.extend(scope));
          const whileActive = yield* events.publish(invalidKnownEvent).pipe(Effect.exit);
          yield* Scope.close(scope, Exit.void);
          const afterRelease = yield* events.publish(invalidKnownEvent).pipe(Effect.exit);
          return { whileActive, afterRelease };
        }),
      ).pipe(Effect.provide(EventServiceLive)),
    );

    expect(Exit.isFailure(outcome.whileActive)).toBe(true);
    expect(Exit.isSuccess(outcome.afterRelease)).toBe(true);
  });

  test("a consumer registered before publish still receives matching valid events", async () => {
    const received = await Effect.runPromise(
      Effect.flatMap(EventService, (events) =>
        Effect.scoped(
          Effect.gen(function* () {
            const queue = yield* events.subscribeQueue;
            yield* events.publish(preAppStartEvent);
            return yield* Queue.take(queue);
          }),
        ),
      ).pipe(Effect.provide(EventServiceLive)),
    );

    expect(received).toEqual(preAppStartEvent);
  });
});
