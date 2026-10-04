import { describe, expect, test } from "bun:test";

import { type Context, DateTime, Effect, Layer, Queue, Schema } from "effect";

import { DownloadProgressEvent } from "@lando/sdk/events";
import { GlobalConfig } from "@lando/sdk/schema";
import { ConfigService, EventService } from "@lando/sdk/services";
import { EventDeliveryMetrics } from "../../src/services/event-service.ts";

import * as LandoEventService from "../../src/services/event-service.ts";
import { EventDispatchControl } from "../../src/services/event-service.ts";

const progressEvent = (bytesDownloaded: number): DownloadProgressEvent =>
  Schema.decodeUnknownSync(DownloadProgressEvent)({
    _tag: "download-progress",
    eventName: "download-progress",
    urlOrigin: "https://example.com",
    bytesDownloaded,
    timestamp: DateTime.formatIso(DateTime.makeUnsafe("2026-07-19T20:00:00Z")),
  });

describe("EventService bounded delivery", () => {
  test("uses the delivery capacity from GlobalConfig", async () => {
    const loaded = Schema.decodeUnknownSync(GlobalConfig)({
      events: { deliveryQueueCapacity: 1 },
    });
    const configService: Context.Service.Shape<typeof ConfigService> = ConfigService.of({
      load: Effect.succeed(loaded),
      get: (key) => Effect.succeed(loaded[key]),
    });
    const layer = LandoEventService.layerRuntimeWithConfig().pipe(
      Layer.provide(Layer.succeed(ConfigService, configService)),
    );

    const delivered = await Effect.runPromise(
      Effect.flatMap(EventService, (events) =>
        Effect.scoped(
          Effect.gen(function* () {
            const queue = yield* events.subscribeQueue;
            yield* events.publish(progressEvent(1));
            yield* events.publish(progressEvent(2));
            return yield* Queue.clear(queue);
          }),
        ),
      ).pipe(Effect.provide(layer)),
    );

    expect(delivered.map((event) => event.bytesDownloaded)).toEqual([1]);
  });

  test("publish completes without waiting when a stalled subscriber reaches capacity", async () => {
    const layer = LandoEventService.layerWith(8, {}, 2);

    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const events = yield* EventService;
        const metrics = yield* EventDeliveryMetrics;
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const queue = yield* events.subscribeQueue;
            yield* events.publish(progressEvent(1));
            yield* events.publish(progressEvent(2));
            const publishFiber = yield* events.publish(progressEvent(3)).pipe(Effect.forkChild);
            yield* Effect.yieldNow;
            const publishExit = publishFiber.pollUnsafe();
            const delivered = yield* Queue.clear(queue);
            const snapshot = yield* metrics.snapshot;
            return { publishExit, delivered, snapshot };
          }),
        );
      }).pipe(Effect.provide(layer)),
    );

    expect(outcome.publishExit).not.toBeUndefined();
    expect(outcome.delivered.map((event) => event.bytesDownloaded)).toEqual([1, 2]);
    expect(outcome.snapshot).toEqual({ capacity: 2, droppedEvents: 1 });
  });

  test("overflow accounting increments once per rejected subscriber delivery", async () => {
    const layer = LandoEventService.layerWith(0, {}, 1);

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

  test("a draining subscriber continues receiving while another subscriber stalls", async () => {
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const events = yield* EventService;
        return yield* Effect.scoped(
          Effect.gen(function* () {
            yield* events.subscribeQueue;
            const draining = yield* events.subscribeQueue;
            yield* events.publish(progressEvent(1));
            const first = yield* Queue.take(draining);
            const secondTake = yield* Queue.take(draining).pipe(Effect.forkChild);
            yield* events.publish(progressEvent(2));
            yield* Effect.yieldNow;
            return { first, second: secondTake.pollUnsafe() };
          }),
        );
      }).pipe(Effect.provide(LandoEventService.layerWith(0, {}, 1))),
    );

    expect(outcome.first.bytesDownloaded).toBe(1);
    expect(outcome.second).not.toBeUndefined();
  });

  test("one overflow rejected by two stalled subscribers increments accounting by two", async () => {
    const snapshot = await Effect.runPromise(
      Effect.gen(function* () {
        const events = yield* EventService;
        const metrics = yield* EventDeliveryMetrics;
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* events.subscribeQueue;
            yield* events.subscribeQueue;
            yield* events.publish(progressEvent(1));
            yield* events.publish(progressEvent(2));
          }),
        );
        return yield* metrics.snapshot;
      }).pipe(Effect.provide(LandoEventService.layerWith(0, {}, 1))),
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
            const delivered = yield* Queue.clear(queue);
            const history = yield* events.query("download-progress");
            return { delivered, history };
          }),
        );
      }).pipe(Effect.provide(LandoEventService.layerWith(8, {}, 1))),
    );

    expect(outcome.delivered.map((event) => event.bytesDownloaded)).toEqual([1]);
    expect(outcome.history.map((event) => event.bytesDownloaded)).toEqual([1, 2]);
    expect(dispatches).toBe(2);
  });

  test("zero subscribers bypass delivery and history when both paths are disabled", async () => {
    let publishCalls = 0;
    const layer = LandoEventService.layerWith(
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

  test("scoped subscriber cleanup restores the zero-subscriber bypass", async () => {
    let publishCalls = 0;
    const layer = LandoEventService.layerWith(
      0,
      {
        onPubSubPublish: () => {
          publishCalls += 1;
        },
      },
      1,
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const events = yield* EventService;
        yield* Effect.scoped(events.subscribeQueue);
        yield* events.publish(progressEvent(1));
      }).pipe(Effect.provide(layer)),
    );

    expect(publishCalls).toBe(0);
  });
});
