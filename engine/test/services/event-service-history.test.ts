import { describe, expect, test } from "bun:test";
import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import { EventService } from "@lando/sdk/services";
import { Deferred, Effect, Exit, Fiber, Layer, Queue, Scope } from "effect";
import * as Events from "../../src/services/event-service.ts";

const message = (body: string) => ({
  _tag: "message.info",
  body,
  timestamp: "2026-10-30T00:00:00Z",
});

describe("EventService.subscribeWithHistory", () => {
  test("delivers exactly once when acquisition races a publish suspended in redaction", async () => {
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        const redaction = makeRedactionService();
        let redactions = 0;
        const layer = Events.layerWith(2).pipe(
          Layer.provide(
            Layer.succeed(RedactionService, {
              ...redaction,
              forProfile: (profile, options) =>
                Effect.gen(function* () {
                  redactions += 1;
                  if (redactions === 2) {
                    yield* Deferred.succeed(entered, undefined);
                    yield* Deferred.await(resume);
                  }
                  return yield* redaction.forProfile(profile, options);
                }),
            }),
          ),
        );
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const events = yield* EventService;
            yield* events.publish(message("before"));
            const publishing = yield* events.publish(message("during")).pipe(Effect.forkChild);
            yield* Deferred.await(entered);
            const subscription = yield* events.subscribeWithHistory();
            yield* Deferred.succeed(resume, undefined);
            yield* Fiber.join(publishing);
            const after = yield* events.subscribeWithHistory();
            return {
              history: subscription.history,
              queued: yield* Queue.clear(subscription.queue),
              after: after.history,
              redactions,
            };
          }),
        ).pipe(Effect.provide(layer));
      }),
    );
    expect(outcome.history).toEqual([message("before")]);
    expect(outcome.queued).toEqual([message("during")]);
    expect(outcome.after).toEqual([message("before"), message("during")]);
    expect(outcome.redactions).toBe(2);
  });

  test("counts rejected deliveries independently for differently paced subscribers", async () => {
    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const events = yield* EventService;
          const slow = yield* events.subscribeWithHistory({ capacity: 1 });
          const fast = yield* events.subscribeWithHistory({ capacity: 1 });
          const received = [];
          for (const body of ["one", "two", "three"]) {
            yield* events.publish(message(body));
            received.push(yield* Queue.take(fast.queue));
          }
          return {
            received,
            slow: yield* slow.dropped,
            fast: yield* fast.dropped,
            global: yield* (yield* Events.EventDeliveryMetrics).snapshot,
          };
        }),
      ).pipe(Effect.provide(Events.layerWith(2, {}, 1))),
    );
    expect(outcome.received).toEqual(["one", "two", "three"].map(message));
    expect(outcome.slow).toBe(2);
    expect(outcome.fast).toBe(0);
    expect(outcome.global.droppedEvents).toBe(2);
  });

  test.each([undefined, 2])("bounds the live queue with capacity %s", async (capacity) => {
    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const events = yield* EventService;
          const subscription = yield* events.subscribeWithHistory(
            capacity === undefined ? undefined : { capacity },
          );
          for (const body of ["one", "two", "three", "four"]) yield* events.publish(message(body));
          return { queued: yield* Queue.clear(subscription.queue), dropped: yield* subscription.dropped };
        }),
      ).pipe(Effect.provide(Events.layerWith(2, {}, 1))),
    );
    const bound = capacity ?? 1;
    expect(outcome.queued).toEqual(["one", "two"].slice(0, bound).map(message));
    expect(outcome.dropped).toBe(4 - bound);
  });

  test("delivers identical repeated events without value-based deduplication", async () => {
    const repeated = message("same");
    const queued = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const events = yield* EventService;
          yield* events.publish(repeated);
          const subscription = yield* events.subscribeWithHistory();
          yield* events.publish(repeated);
          yield* events.publish(repeated);
          return [...subscription.history, ...(yield* Queue.clear(subscription.queue))];
        }),
      ).pipe(Effect.provide(Events.layer)),
    );
    expect(queued).toEqual([repeated, repeated, repeated]);
  });

  test("stop is idempotent and preserves queued events while preventing new deliveries", async () => {
    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const events = yield* EventService;
          const subscription = yield* events.subscribeWithHistory({ capacity: 1 });
          yield* events.publish(message("queued"));
          yield* events.publish(message("rejected"));
          yield* subscription.stop;
          yield* subscription.stop;
          yield* events.publish(message("after stop"));
          return { queued: yield* Queue.clear(subscription.queue), dropped: yield* subscription.dropped };
        }),
      ).pipe(Effect.provide(Events.layer)),
    );
    expect(outcome.queued).toEqual([message("queued")]);
    expect(outcome.dropped).toBe(1);
  });

  test.each([false, true])("scope release shuts down the queue after explicit stop = %s", async (stop) => {
    const shutdown = await Effect.runPromise(
      Effect.gen(function* () {
        const events = yield* EventService;
        const scope = yield* Scope.make();
        const subscription = yield* events.subscribeWithHistory().pipe(Scope.provide(scope));
        if (stop) yield* subscription.stop;
        yield* Scope.close(scope, Exit.void);
        return {
          take: yield* Queue.take(subscription.queue).pipe(Effect.exit),
          publish: yield* events.publish({ _tag: "download-progress", bytes: 1 }).pipe(Effect.exit),
        };
      }).pipe(Effect.provide(Events.layer)),
    );
    expect(Exit.isFailure(shutdown.take)).toBe(true);
    expect(Exit.isSuccess(shutdown.publish)).toBe(true);
  });

  test("retains a bounded immutable redacted snapshot unaffected by later publications", async () => {
    const redaction = makeRedactionService();
    const token = "private-secret-token";
    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* redaction.registerValues([token]);
          const events = yield* EventService;
          for (const body of ["evicted", token, "last"]) yield* events.publish(message(body));
          const subscription = yield* events.subscribeWithHistory();
          yield* events.publish(message(token));
          return { history: subscription.history, queued: yield* Queue.clear(subscription.queue) };
        }),
      ).pipe(
        Effect.provide(Events.layerWith(2).pipe(Layer.provide(Layer.succeed(RedactionService, redaction)))),
      ),
    );
    expect(outcome.history).toEqual([message("[redacted]"), message("last")]);
    expect(Object.isFrozen(outcome.history)).toBe(true);
    expect(outcome.queued).toEqual([message("[redacted]")]);
  });

  test("skips decode and bus work when the final subscriber stops during redaction", async () => {
    let decodes = 0;
    let bus = 0;
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        const redaction = makeRedactionService();
        const layer = Events.layerWith(2, {
          onPayloadDecode: () => {
            decodes += 1;
          },
          onPubSubPublish: () => {
            bus += 1;
          },
        }).pipe(
          Layer.provide(
            Layer.succeed(RedactionService, {
              ...redaction,
              forProfile: (profile, options) =>
                Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(resume)),
                  Effect.andThen(redaction.forProfile(profile, options)),
                ),
            }),
          ),
        );
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const events = yield* EventService;
            const subscription = yield* events.subscribeWithHistory();
            const publishing = yield* events
              .publish({ _tag: "download-progress", bytes: 1 })
              .pipe(Effect.forkChild);
            yield* Deferred.await(entered);
            yield* subscription.stop;
            yield* Deferred.succeed(resume, undefined);
            yield* Fiber.join(publishing);
            return (yield* events.subscribeWithHistory()).history;
          }),
        ).pipe(Effect.provide(layer));
      }),
    );
    expect(outcome).toHaveLength(1);
    expect(decodes).toBe(0);
    expect(bus).toBe(0);
  });
});
