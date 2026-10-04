import { describe, expect, test } from "bun:test";
import { TestClock } from "effect/testing";

import { Cause, Effect, Exit, Fiber } from "effect";

import * as LandoEventService from "@lando/engine/services/event-service";
import { expectEvent } from "../../src/testing/events.ts";

describe("expectEvent", () => {
  test("uses a five-second default timeout when options omit timeout", async () => {
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const waiter = yield* expectEvent("download-progress").pipe(Effect.exit, Effect.forkChild);
        yield* TestClock.adjust("6 seconds");
        return yield* Fiber.join(waiter);
      }).pipe(Effect.provide(LandoEventService.layer), Effect.provide(TestClock.layer())),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = Cause.findErrorOption(exit.cause);
      expect(error._tag).toBe("Some");
      if (error._tag === "Some") {
        expect(error.value._tag).toBe("EventError");
        expect(error.value.reason).toBe("timeout");
      }
    }
  });

  test("keeps the default timeout when passed an empty options object", async () => {
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const waiter = yield* expectEvent("download-progress", {}).pipe(Effect.exit, Effect.forkChild);
        yield* TestClock.adjust("6 seconds");
        return yield* Fiber.join(waiter);
      }).pipe(Effect.provide(LandoEventService.layer), Effect.provide(TestClock.layer())),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = Cause.findErrorOption(exit.cause);
      expect(error._tag).toBe("Some");
      if (error._tag === "Some") {
        expect(error.value._tag).toBe("EventError");
        expect(error.value.reason).toBe("timeout");
      }
    }
  });
});
