import { expect, test } from "bun:test";
import { makeTestRuntime } from "@lando/core/testing";
import { GlobalConfig } from "@lando/sdk/schema";
import { EventService } from "@lando/sdk/services";
import { Effect, Exit, Queue, Schema, Scope } from "effect";

test("TestRuntime snapshots bounded redacted history independently from its call recorder", async () => {
  const runtime = makeTestRuntime();
  const outcome = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const events = yield* EventService;
        for (let index = 0; index < 65; index += 1) {
          yield* events.publish({ _tag: "fixture", index, password: "private-password" });
        }
        const subscription = yield* events.subscribeWithHistory();
        yield* events.publish({ _tag: "fixture", password: "live-password" });
        return { history: subscription.history, queued: yield* Queue.clear(subscription.queue) };
      }),
    ).pipe(Effect.provide(runtime.layer)),
  );
  expect(outcome.history).toHaveLength(64);
  expect(outcome.history[0]?.index).toBe(1);
  expect(Object.isFrozen(outcome.history)).toBe(true);
  expect(JSON.stringify(outcome)).not.toContain("private-password");
  expect(outcome.queued).toEqual([{ _tag: "fixture", password: "[redacted]", timestamp: undefined }]);
  expect(runtime.calls.events).toHaveLength(66);
});

test("TestRuntime tracks subscription drops and preserves the queue until scope release", async () => {
  const runtime = makeTestRuntime({
    config: Schema.decodeUnknownSync(GlobalConfig)({ events: { deliveryQueueCapacity: 1 } }),
  });
  const outcome = await Effect.runPromise(
    Effect.gen(function* () {
      const events = yield* EventService;
      const scope = yield* Scope.make();
      const subscription = yield* events.subscribeWithHistory().pipe(Scope.provide(scope));
      for (const index of [1, 2, 3]) yield* events.publish({ _tag: "fixture", index });
      yield* subscription.stop;
      yield* subscription.stop;
      yield* events.publish({ _tag: "fixture", index: 4 });
      const queued = yield* Queue.clear(subscription.queue);
      const dropped = yield* subscription.dropped;
      yield* Scope.close(scope, Exit.void);
      const released = yield* Queue.take(subscription.queue).pipe(Effect.exit);
      return { queued, dropped, released };
    }).pipe(Effect.provide(runtime.layer)),
  );
  expect(outcome.queued.map((event) => event.index)).toEqual([1]);
  expect(outcome.dropped).toBe(2);
  expect(Exit.isFailure(outcome.released)).toBe(true);
});
