import { expect, test } from "bun:test";
import { Clock, Deferred, Effect, Exit, Fiber, Logger, type Schema } from "effect";
import { TestClock } from "effect/testing";
import {
  FRAMING_CASES,
  type FramingCase,
  containsReplies,
  expectedReplies,
  ping,
} from "./fixtures/framing-cases";
import { serverLayer, startServer } from "./server";
import { expectMcpTransportFailure } from "./stdio-transport-test-support";

const runMemoryCase = (
  row: FramingCase,
  timing?: { readonly clock: TestClock.TestClock; readonly armed: Deferred.Deferred<void> },
) =>
  Effect.gen(function* () {
    const client = yield* startServer();
    let elapsed = 0;
    if (timing !== undefined) {
      // Wrap the server clock only after initialization, so no outbound timer can
      // satisfy the first partial-frame timer's readiness signal.
      yield* Deferred.succeed(timing.armed, undefined);
    }
    for (const write of row.writes) {
      if (write.advanceBeforeMs !== undefined && timing !== undefined) {
        yield* timing.clock.adjust(write.advanceBeforeMs);
        elapsed += write.advanceBeforeMs;
        expect(client.fiber.pollUnsafe()).toBeUndefined();
      }
      yield* client.raw(write.bytes());
      if (timing !== undefined) yield* timing.clock.adjust(0);
    }
    if (timing !== undefined) {
      yield* timing.clock.adjust(4_999 - elapsed);
      expect(client.fiber.pollUnsafe()).toBeUndefined();
      yield* timing.clock.adjust(1);
    }
    if (row.closeInput === "before-replies") yield* client.close;
    if (row.closeInput === "after-replies") {
      yield* Effect.raceFirst(
        Effect.gen(function* () {
          const observed: Schema.JsonObject[] = [];
          while (!containsReplies(observed, row.replies)) observed.push(yield* client.next);
          if (row.usabilityPing) {
            yield* client.send(ping(21));
            let frame = yield* client.next;
            while (frame.id !== 21) frame = yield* client.next;
          }
        }),
        Fiber.join(client.fiber).pipe(Effect.andThen(Effect.never)),
      );
      yield* client.close;
    }
    const exit = yield* Fiber.await(client.fiber);
    return { exit, replies: (yield* client.messages).slice(1) };
  });

test.each(FRAMING_CASES)("stdio framing: $id", async (row) => {
  const errors: unknown[] = [];
  const run = row.virtualTime
    ? TestClock.testClockWith((clock) =>
        Effect.gen(function* () {
          const armed = yield* Deferred.make<void>();
          const timer = yield* Deferred.make<void>();
          return yield* runMemoryCase(row, {
            clock: {
              ...clock,
              adjust: (ms) => Deferred.await(timer).pipe(Effect.andThen(clock.adjust(ms))),
            },
            armed,
          }).pipe(
            Effect.provideService(Clock.Clock, {
              ...clock,
              sleep: (duration) =>
                Effect.gen(function* () {
                  if (yield* Deferred.isDone(armed)) yield* Deferred.succeed(timer, undefined);
                  yield* clock.sleep(duration);
                }),
            }),
          );
        }),
      ).pipe(Effect.provide(TestClock.layer()))
    : runMemoryCase(row);
  const { exit, replies } = await Effect.runPromise(
    run.pipe(
      Effect.scoped,
      Effect.provide(serverLayer()),
      Effect.provide(
        Logger.layer([
          Logger.make((event) => {
            if (event.logLevel === "Error") errors.push(event.message);
          }),
        ]),
      ),
      Effect.timeout("4 seconds"),
    ),
  );
  if (row.exit === "clean") {
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(errors).toEqual([]);
  } else {
    expect(expectMcpTransportFailure(exit)).toMatchObject(row.exit);
  }
  const expected = expectedReplies(row);
  expect(replies).toHaveLength(expected.length);
  expect(containsReplies(replies, expected)).toBe(true);
});
