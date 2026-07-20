import { describe, expect, test } from "bun:test";

import { Chunk, type Context, DateTime, Effect, Fiber, Layer, Option, Queue, Schema } from "effect";

import { EventDeliveryMetrics } from "@lando/core/services";
import { DownloadProgressEvent } from "@lando/sdk/events";
import { GlobalConfig } from "@lando/sdk/schema";
import { ConfigService, EventService } from "@lando/sdk/services";

import {
  EventDispatchControl,
  makeEventRuntimeLive,
  makeEventServiceLive,
} from "../../src/services/event-service.ts";

const progressEvent = (bytesDownloaded: number): DownloadProgressEvent =>
  Schema.decodeUnknownSync(DownloadProgressEvent)({
    _tag: "download-progress",
    eventName: "download-progress",
    urlOrigin: "https://example.com",
    bytesDownloaded,
    timestamp: DateTime.formatIso(DateTime.unsafeMake("2026-07-19T20:00:00Z")),
  });

describe("EventService bounded delivery", () => {
  test("uses the delivery capacity from GlobalConfig", async () => {
    const loaded = Schema.decodeUnknownSync(GlobalConfig)({
      events: { deliveryQueueCapacity: 1 },
    });
    const configService: Context.Tag.Service<typeof ConfigService> = {
      load: Effect.succeed(loaded),
      get: (key) => Effect.succeed(loaded[key]),
    };
    const layer = makeEventRuntimeLive().pipe(Layer.provide(Layer.succeed(ConfigService, configService)));

    const delivered = await Effect.runPromise(
      Effect.flatMap(EventService, (events) =>
        Effect.scoped(
          Effect.gen(function* () {
            const queue = yield* events.subscribeQueue;
            yield* events.publish(progressEvent(1));
            yield* events.publish(progressEvent(2));
            return Chunk.toReadonlyArray(yield* Queue.takeAll(queue));
          }),
        ),
      ).pipe(Effect.provide(layer)),
    );

    expect(delivered.map((event) => event.bytesDownloaded)).toEqual([1]);
  });

  test("publish completes without waiting when a stalled subscriber reaches capacity", async () => {
    const layer = makeEventServiceLive(8, {}, 2);

    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const events = yield* EventService;
        const metrics = yield* EventDeliveryMetrics;
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const queue = yield* events.subscribeQueue;
            yield* events.publish(progressEvent(1));
            yield* events.publish(progressEvent(2));
            const publishFiber = yield* events.publish(progressEvent(3)).pipe(Effect.fork);
            yield* Effect.yieldNow();
            const publishExit = yield* Fiber.poll(publishFiber);
            const delivered = Chunk.toReadonlyArray(yield* Queue.takeAll(queue));
            const snapshot = yield* metrics.snapshot;
            return { publishExit, delivered, snapshot };
          }),
        );
      }).pipe(Effect.provide(layer)),
    );

    expect(Option.isSome(outcome.publishExit)).toBe(true);
    expect(outcome.delivered.map((event) => event.bytesDownloaded)).toEqual([1, 2]);
    expect(outcome.snapshot).toEqual({ capacity: 2, droppedEvents: 1 });
  });

  test("overflow accounting increments once per dropped event", async () => {
    const layer = makeEventServiceLive(0, {}, 1);

    const snapshot = await Effect.runPromise(
      Effect.gen(function* () {
        const events = yield* EventService;
        const metrics = yield* EventDeliveryMetrics;
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* events.subscribeQueue;
            yield* events.publish(progressEvent(1));
            yield* events.publish(progressEvent(2));
            yield* events.publish(progressEvent(3));
          }),
        );
        return yield* metrics.snapshot;
      }).pipe(Effect.provide(layer)),
    );

    expect(snapshot).toEqual({ capacity: 1, droppedEvents: 2 });
  });

  test("overflow leaves history and manifest dispatch independent from dynamic delivery", async () => {
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
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const queue = yield* events.subscribeQueue;
            yield* events.publish(progressEvent(1));
            yield* events.publish(progressEvent(2));
            const delivered = Chunk.toReadonlyArray(yield* Queue.takeAll(queue));
            const history = yield* events.query("download-progress");
            return { delivered, history };
          }),
        );
      }).pipe(Effect.provide(makeEventServiceLive(8, {}, 1))),
    );

    expect(outcome.delivered.map((event) => event.bytesDownloaded)).toEqual([1]);
    expect(outcome.history.map((event) => event.bytesDownloaded)).toEqual([1, 2]);
    expect(dispatches).toBe(2);
  });

  test("zero subscribers bypass delivery and history when both paths are disabled", async () => {
    let publishCalls = 0;
    const layer = makeEventServiceLive(
      0,
      {
        onPubSubPublish: () => {
          publishCalls += 1;
        },
      },
      1,
    );

    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const events = yield* EventService;
        const metrics = yield* EventDeliveryMetrics;
        yield* events.publish(progressEvent(1));
        return { history: yield* events.query("*"), snapshot: yield* metrics.snapshot };
      }).pipe(Effect.provide(layer)),
    );

    expect(publishCalls).toBe(0);
    expect(outcome.snapshot.droppedEvents).toBe(0);
    expect(outcome.history).toEqual([]);
  });
});
