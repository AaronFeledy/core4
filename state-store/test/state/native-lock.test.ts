/**
 * Cross-process native advisory lock gates (source Bun children).
 * Selected on every OS via the `native-lock` CI selection.
 */
import { describe, expect, test } from "bun:test";
import { Clock, Effect, Exit, Fiber, Latch } from "effect";
import { acquireAdvisoryLockAt } from "../../src/lock.ts";
import { lockTestAccess } from "./lock-test-access.ts";
import {
  acquireExclusive,
  removeDir,
  runWithScope,
  sentinelPath,
  sourceHolderCommand,
  spawnHolder,
  tempLockDir,
} from "./native-lock-support.ts";

describe("native advisory lock (source two-process)", () => {
  test("exclusive: second process waits until the holder releases", async () => {
    const dir = await tempLockDir();
    const sentinel = sentinelPath(dir);
    try {
      const holder = await spawnHolder(sourceHolderCommand(), sentinel, { mode: "exclusive" });
      const started = Date.now();
      const acquiring = runWithScope(
        Effect.gen(function* () {
          const lock = yield* acquireExclusive(sentinel, { timeoutMs: 10_000, resource: "ex-wait" });
          return { token: lock.token, waitedMs: Date.now() - started };
        }),
      );
      // The measured wait is the behavior under test, so the hold is time-based.
      await Bun.sleep(50);
      holder.release();
      const [exitCode, stderr, acquired] = await Promise.all([holder.exited, holder.stderr, acquiring]);
      expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
      expect(acquired.token).not.toBe(holder.token);
      expect(acquired.waitedMs).toBeGreaterThanOrEqual(40);
    } finally {
      await removeDir(dir);
    }
  });

  test("exclusive: contending process times out with lockFailure timeout", async () => {
    const dir = await tempLockDir();
    const sentinel = sentinelPath(dir);
    try {
      const holder = await spawnHolder(sourceHolderCommand(), sentinel, {
        mode: "exclusive",
        resource: "cache",
      });
      try {
        const error = await runWithScope(
          Effect.flip(
            acquireExclusive(sentinel, {
              timeoutMs: 80,
              resource: "cache",
            }),
          ),
        );
        expect(error).toMatchObject({
          reason: "lock",
          lockFailure: "timeout",
          resource: "cache",
          ownerPid: holder.pid,
          timeoutMs: 80,
        });
        expect(error.heldMs).toBeGreaterThanOrEqual(0);
      } finally {
        holder.release();
        await holder.exited;
      }
    } finally {
      await removeDir(dir);
    }
  });

  test("shared: two processes hold shared concurrently; exclusive waits", async () => {
    const dir = await tempLockDir();
    const sentinel = sentinelPath(dir);
    try {
      const a = await spawnHolder(sourceHolderCommand(), sentinel, { mode: "shared" });
      const b = await spawnHolder(sourceHolderCommand(), sentinel, { mode: "shared" });
      expect(a.pid).not.toBe(b.pid);

      const exclusiveAttempt = runWithScope(
        Effect.result(acquireExclusive(sentinel, { timeoutMs: 0, resource: "shared-gate" })),
      );
      const exclusiveResult = await exclusiveAttempt;
      expect(exclusiveResult._tag).toBe("Failure");
      if (exclusiveResult._tag === "Failure") {
        expect(exclusiveResult.failure.lockFailure).toBe("timeout");
      }

      a.release();
      b.release();
      const [aExit, bExit] = await Promise.all([a.exited, b.exited]);
      expect(aExit).toBe(0);
      expect(bExit).toBe(0);

      // After both shared holders leave, exclusive succeeds.
      await runWithScope(
        Effect.gen(function* () {
          yield* acquireExclusive(sentinel, { timeoutMs: 2_000 });
        }),
      );
    } finally {
      await removeDir(dir);
    }
  });

  test("interrupt: waiting fiber is interruptible and does not leave a stuck hold", async () => {
    const dir = await tempLockDir();
    const sentinel = sentinelPath(dir);
    try {
      const holder = await spawnHolder(sourceHolderCommand(), sentinel, { mode: "exclusive" });
      try {
        await Effect.runPromise(
          Effect.gen(function* () {
            const probed = yield* Latch.make();
            const fiber = yield* Effect.forkChild(
              Effect.scoped(
                acquireAdvisoryLockAt(sentinel, "test", {
                  timeoutMs: 30_000,
                  resource: "interrupt-wait",
                  privateFileAccess: {
                    enforce: lockTestAccess.enforce,
                    verify: () => Effect.runPromise(Effect.asVoid(probed.open)),
                  },
                }),
              ),
            );
            // The waiter verifies the sentinel on every probe, so it is now in the poll loop.
            yield* probed.await.pipe(Effect.timeout("2 seconds"));
            yield* Fiber.interrupt(fiber);
            const waited = yield* Fiber.await(fiber);
            expect(Exit.isFailure(waited)).toBe(true);
          }),
        );
        // After interrupt, a fresh acquire still only waits on the live holder.
        const blocked = await runWithScope(Effect.result(acquireExclusive(sentinel, { timeoutMs: 0 })));
        expect(blocked._tag).toBe("Failure");
      } finally {
        holder.release();
        await holder.exited;
      }
      // Holder released: acquire succeeds.
      await runWithScope(acquireExclusive(sentinel, { timeoutMs: 2_000 }));
    } finally {
      await removeDir(dir);
    }
  });
});

for (const mode of ["exclusive", "shared"] as const) {
  test.skipIf(process.platform === "win32")(
    `a waiter in ${mode} mode retries an unlinked inode before entering`,
    async () => {
      const dir = await tempLockDir();
      const sentinel = sentinelPath(dir);
      try {
        const holder = await spawnHolder(sourceHolderCommand(), sentinel);
        try {
          await Effect.runPromise(
            Effect.gen(function* () {
              const opened = yield* Latch.make();
              const resume = yield* Latch.make();
              const checked = yield* Latch.make();
              const clock = yield* Clock.Clock;
              const waiter = yield* Effect.forkChild(
                Effect.scoped(
                  acquireAdvisoryLockAt(sentinel, "waiter", {
                    mode,
                    timeoutMs: 8_000,
                    privateFileAccess: {
                      enforce: lockTestAccess.enforce,
                      verify: () => Effect.runPromise(Effect.asVoid(checked.open)),
                    },
                  }),
                ).pipe(
                  Effect.provideService(Clock.Clock, {
                    ...clock,
                    currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe(),
                    currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
                    monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
                    sleep: (duration) => clock.sleep(duration),
                    currentTimeMillis: opened.open.pipe(
                      Effect.andThen(resume.await),
                      Effect.andThen(clock.currentTimeMillis),
                    ),
                  }),
                ),
              );
              yield* opened.await.pipe(Effect.timeout("2 seconds"));
              holder.release();
              expect(yield* Effect.promise(() => holder.exited)).toBe(0);
              expect(yield* Effect.promise(() => Bun.file(sentinel).exists())).toBe(false);

              const successor = yield* Effect.promise(() => spawnHolder(sourceHolderCommand(), sentinel));
              try {
                yield* resume.open;
                yield* Effect.raceFirst(
                  checked.await,
                  Fiber.join(waiter).pipe(
                    Effect.andThen(Effect.die(new Error("Waiter entered while the successor held the lock"))),
                  ),
                ).pipe(Effect.timeout("2 seconds"));
                expect(yield* Effect.promise(() => Bun.file(sentinel).json())).toMatchObject({
                  token: successor.token,
                });
              } finally {
                successor.release();
                expect(yield* Effect.promise(() => successor.exited)).toBe(0);
              }
              yield* Fiber.join(waiter);
            }),
          );
        } finally {
          holder.release();
          await holder.exited;
        }
      } finally {
        await removeDir(dir);
      }
    },
    10_000,
  );
}
