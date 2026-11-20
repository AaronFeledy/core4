import { describe, expect, test } from "bun:test";
import { Cause, Deferred, Effect, Exit, Fiber, Result } from "effect";

import { makeTestStateStore } from "../../src/testing.ts";

describe("in-memory advisory lock", () => {
  test("same-fiber re-entry dies at once instead of waiting on its own lock", async () => {
    // Given an in-memory state store and a lock key this fiber already holds.
    const store = makeTestStateStore().service;

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
      }
    }
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

  test("shared mode allows concurrent shared holders", async () => {
    const store = makeTestStateStore().service;
    const aEntered = await Effect.runPromise(Deferred.make<void>());
    const bEntered = await Effect.runPromise(Deferred.make<void>());
    const release = await Effect.runPromise(Deferred.make<void>());
    const holdShared = (entered: typeof aEntered) =>
      store.withLock(
        "cache",
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
        { mode: "shared", resource: "cache" },
      );
    const first = Effect.runFork(holdShared(aEntered));
    const second = Effect.runFork(holdShared(bEntered));
    await Effect.runPromise(Deferred.await(aEntered));
    await Effect.runPromise(Deferred.await(bEntered));
    await Effect.runPromise(Deferred.succeed(release, undefined));
    await Effect.runPromise(Fiber.join(first));
    await Effect.runPromise(Fiber.join(second));
  });

  test("exclusive acquisition fails while a shared holder is active", async () => {
    const store = makeTestStateStore().service;
    await Effect.runPromise(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const holder = yield* Effect.forkChild(
          store.withLock(
            "cache",
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
            { mode: "shared" },
          ),
        );
        yield* Deferred.await(entered);
        const result = yield* Effect.result(
          store.withLock("cache", Effect.succeed("exclusive"), { mode: "exclusive", timeoutMs: 0 }),
        );
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          expect(result.failure).toMatchObject({
            reason: "lock",
            lockFailure: "timeout",
            timeoutMs: 0,
          });
        }
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(holder);
      }),
    );
  });

  test("shared acquisition fails while an exclusive holder is active", async () => {
    const store = makeTestStateStore().service;
    await Effect.runPromise(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const holder = yield* Effect.forkChild(
          store.withLock(
            "cache",
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
            { mode: "exclusive" },
          ),
        );
        yield* Deferred.await(entered);
        const result = yield* Effect.result(
          store.withLock("cache", Effect.succeed("shared"), { mode: "shared", timeoutMs: 0 }),
        );
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          expect(result.failure.lockFailure).toBe("timeout");
        }
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(holder);
      }),
    );
  });

  test("wait budget times out and zero budget is one nonblocking attempt", async () => {
    const store = makeTestStateStore().service;
    await Effect.runPromise(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const holder = yield* Effect.forkChild(
          store.withLock(
            "budget",
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
          ),
        );
        yield* Deferred.await(entered);

        const zeroStarted = Date.now();
        const zero = yield* Effect.result(store.withLock("budget", Effect.succeed("zero"), { timeoutMs: 0 }));
        expect(Date.now() - zeroStarted).toBeLessThan(500);
        expect(zero._tag).toBe("Failure");
        if (zero._tag === "Failure") {
          expect(zero.failure).toMatchObject({
            reason: "lock",
            lockFailure: "timeout",
            timeoutMs: 0,
            resource: "budget",
          });
        }

        const waitedStarted = Date.now();
        const waited = yield* Effect.result(
          store.withLock("budget", Effect.succeed("waited"), { timeoutMs: 60, resource: "budget" }),
        );
        expect(Date.now() - waitedStarted).toBeGreaterThanOrEqual(50);
        expect(waited._tag).toBe("Failure");
        if (waited._tag === "Failure") {
          expect(waited.failure).toMatchObject({
            lockFailure: "timeout",
            timeoutMs: 60,
            resource: "budget",
          });
          expect(waited.failure.remediation).toMatch(/LANDO_LOCK_TIMEOUT_MS/);
        }

        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(holder);
      }),
    );
  });

  test("exclusive waiter acquires after shared holders release", async () => {
    const store = makeTestStateStore().service;
    const sharedEntered = await Effect.runPromise(Deferred.make<void>());
    const releaseShared = await Effect.runPromise(Deferred.make<void>());
    const exclusiveEntered = await Effect.runPromise(Deferred.make<void>());
    const shared = Effect.runFork(
      store.withLock(
        "handoff",
        Deferred.succeed(sharedEntered, undefined).pipe(Effect.andThen(Deferred.await(releaseShared))),
        { mode: "shared" },
      ),
    );
    await Effect.runPromise(Deferred.await(sharedEntered));
    const exclusive = Effect.runFork(
      store.withLock("handoff", Deferred.succeed(exclusiveEntered, undefined), {
        mode: "exclusive",
        timeoutMs: 5_000,
      }),
    );
    const before = await Effect.runPromise(Deferred.poll(exclusiveEntered));
    expect(before._tag).toBe("None");
    await Effect.runPromise(Deferred.succeed(releaseShared, undefined));
    await Effect.runPromise(Fiber.join(shared));
    await Effect.runPromise(Fiber.join(exclusive));
    expect((await Effect.runPromise(Deferred.poll(exclusiveEntered)))._tag).toBe("Some");
  });
});
