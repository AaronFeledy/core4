import { describe, expect, test } from "bun:test";
import { Cause, Deferred, Effect, Exit, Fiber, Result } from "effect";

import { makeTestStateStore } from "../../src/testing.ts";

describe("in-memory advisory lock", () => {
  test("same-fiber re-entry dies at once instead of waiting on its own lock", async () => {
    // Given an in-memory state store and a lock key this fiber already holds.
    const store = makeTestStateStore().service;
    const started = Date.now();

    // When the same fiber nests an acquisition of the same key.
    const result = await Effect.runPromiseExit(
      store
        .withLock("volume.lock", store.withLock("volume.lock", Effect.succeed("unreachable")))
        .pipe(Effect.timeout("1 second")),
    );

    // Then it fails promptly with the deadlock diagnosis instead of hanging.
    expect(Exit.isFailure(result)).toBe(true);
    if (Exit.isFailure(result)) {
      const defect = Cause.findDefect(result.cause);
      expect(Result.isSuccess(defect)).toBe(true);
      if (Result.isSuccess(defect)) {
        expect(String(defect.success)).toContain("volume.lock");
        expect(String(defect.success)).toContain("Lando bug");
      }
    }
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(await Effect.runPromise(store.withLock("volume.lock", Effect.succeed("released")))).toBe(
      "released",
    );
  });

  test("a different fiber still waits for the held lock and then acquires it", async () => {
    // Given one fiber holding the lock inside its body.
    const store = makeTestStateStore().service;
    const entered = await Effect.runPromise(Deferred.make<void>());
    const release = await Effect.runPromise(Deferred.make<void>());
    const secondEntered = await Effect.runPromise(Deferred.make<void>());
    const first = Effect.runFork(
      store.withLock(
        "volume.lock",
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
      ),
    );
    await Effect.runPromise(Deferred.await(entered));

    // When a different fiber acquires the same key.
    const second = Effect.runFork(store.withLock("volume.lock", Deferred.succeed(secondEntered, undefined)));
    const beforeRelease = await Effect.runPromise(Deferred.poll(secondEntered));
    await Effect.runPromise(Deferred.succeed(release, undefined));
    await Effect.runPromise(Fiber.join(first));
    await Effect.runPromise(Fiber.join(second));

    // Then it serialized instead of dying and entered after the holder released.
    expect(beforeRelease._tag).toBe("None");
    expect((await Effect.runPromise(Deferred.poll(secondEntered)))._tag).toBe("Some");
  });

  test("interruption while holding clears the holder for a later acquisition", async () => {
    // Given a fiber is interrupted while it holds the lock.
    const store = makeTestStateStore().service;
    await Effect.runPromise(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const fiber = yield* Effect.forkChild(
          store.withLock(
            "volume.lock",
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
          ),
        );
        yield* Deferred.await(entered);
        yield* Fiber.interrupt(fiber);
      }),
    );

    // When a later acquisition runs on this fiber.
    const reacquired = await Effect.runPromise(store.withLock("volume.lock", Effect.succeed("reacquired")));

    // Then the stale holder record did not block or falsely reject it.
    expect(reacquired).toBe("reacquired");
  });
});
