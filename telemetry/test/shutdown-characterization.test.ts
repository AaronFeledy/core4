import { expect, test } from "bun:test";
import { Telemetry } from "@lando/sdk/services";
import { type TelemetryRecord, TelemetrySinks, makeTelemetryLayer } from "@lando/telemetry/service";
import { Clock, Deferred, Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";

test("shutdown completes promptly when the telemetry queue is empty", async () => {
  // Given: an idle transport whose sink budget is longer than the native watchdog.
  const deadline = Promise.withResolvers<"deadline">();
  const timer = setTimeout(() => deadline.resolve("deadline"), 1000);
  try {
    // When: close its scope without recording anything.
    const closed = Effect.runPromise(
      Telemetry.pipe(Effect.provide(makeTelemetryLayer(true, { flushBudgetMillis: 10_000 }))),
    ).then(() => "closed");

    // Then: empty drains finish without spending the sink budget.
    expect(await Promise.race([closed, deadline.promise])).toBe("closed");
  } finally {
    clearTimeout(timer);
  }
});

test("shutdown drains queued records before interrupting the in-flight sink", async () => {
  // Given: one blocked dispatch leaves the subsequent records queued.
  const delivered: TelemetryRecord[] = [];
  let interrupted = 0;
  const program = Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const layer = makeTelemetryLayer(true, { flushBudgetMillis: 250 }).pipe(
      Layer.provide(
        Layer.succeed(TelemetrySinks, [
          {
            id: "shutdown-capture",
            record: (event, data) =>
              event === "blocked"
                ? Deferred.succeed(started, undefined).pipe(
                    Effect.andThen(Effect.never),
                    Effect.ensuring(
                      Effect.sync(() => {
                        interrupted += 1;
                      }),
                    ),
                  )
                : Effect.sync(() => {
                    delivered.push({ event, data });
                  }),
          },
        ]),
      ),
    );

    // When: the layer scope closes with two records still waiting.
    yield* Effect.gen(function* () {
      const telemetry = yield* Telemetry;
      yield* telemetry.record("blocked", {});
      yield* Deferred.await(started);
      yield* telemetry.record("queued-one", { count: 1 });
      yield* telemetry.record("queued-two", { count: 2 });
      expect(delivered).toEqual([]);
    }).pipe(Effect.provide(layer));
  });
  await Effect.runPromise(program);

  // Then: scope completion has delivered the queued batch and reaped the blocked dispatch.
  expect(delivered).toEqual([
    { event: "queued-one", data: { count: 1 } },
    { event: "queued-two", data: { count: 2 } },
  ]);
  expect(interrupted).toBe(1);
});

test("shutdown of a hanging queued sink completes at its virtual flush budget", async () => {
  const calls: string[] = [];
  let finalized = 0;
  const layer = makeTelemetryLayer(true, { flushBudgetMillis: 250 }).pipe(
    Layer.provide(
      Layer.succeed(TelemetrySinks, [
        {
          id: "hang",
          record: (event) =>
            Effect.sync(() => {
              calls.push(event);
            }).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(
                Effect.sync(() => {
                  finalized += 1;
                }),
              ),
            ),
        },
      ]),
    ),
  );

  const elapsed = await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.gen(function* () {
        const start = yield* Clock.currentTimeMillis;
        yield* Effect.gen(function* () {
          const telemetry = yield* Telemetry;
          yield* telemetry.record("queued", {});
        }).pipe(Effect.provide(layer));
        return (yield* Clock.currentTimeMillis) - start;
      }).pipe(Effect.forkChild);
      yield* TestClock.adjust(1000);
      return yield* Fiber.join(fiber);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  expect(elapsed).toBe(250);
  expect(calls).toEqual(["queued"]);
  expect(finalized).toBe(1);
});
