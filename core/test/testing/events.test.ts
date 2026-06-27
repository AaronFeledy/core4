import { describe, expect, test } from "bun:test";

import { Cause, Effect, Exit, Fiber, TestClock, TestContext } from "effect";

import { EventServiceLive } from "../../src/services/event-service.ts";
import { expectEvent } from "../../src/testing/events.ts";

describe("expectEvent", () => {
  test("uses a five-second default timeout when options omit timeout", async () => {
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const waiter = yield* expectEvent("download-progress").pipe(Effect.exit, Effect.fork);
        yield* TestClock.adjust("6 seconds");
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
      }
    }
  });

  test("keeps the default timeout when options explicitly pass timeout: undefined", async () => {
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const waiter = yield* expectEvent("download-progress", { timeout: undefined }).pipe(
          Effect.exit,
          Effect.fork,
        );
        yield* TestClock.adjust("6 seconds");
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
      }
    }
  });
});
