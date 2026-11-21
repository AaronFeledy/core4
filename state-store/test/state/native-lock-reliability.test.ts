import { expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { stat } from "node:fs/promises";
import { EventService } from "@lando/sdk/services";
import { Deferred, Effect, Exit, Fiber, Queue } from "effect";
import { acquireAdvisoryLockAt, peekAdvisoryLockRecord } from "../../src/lock.ts";
import { nativeLock } from "../../src/native-lock.ts";
import { lockTestAccess } from "./lock-test-access.ts";
import {
  acquireExclusive,
  acquireShared,
  capturingEventLayer,
  removeDir,
  runWithScope,
  sentinelPath,
  sourceHolderCommand,
  spawnHolder,
  tempLockDir,
} from "./native-lock-support.ts";

const procFd = "/proc/self/fd";
const fdCount = () => readdirSync(procFd).length;
const cycles = 1_000;

test.skipIf(process.platform !== "linux" || !existsSync(procFd))(
  "exclusive, timed-out, interrupted, and shared lock cycles leave no open fds",
  async () => {
    const dir = await tempLockDir();
    const sentinel = sentinelPath(dir);
    const exclusive = Effect.scoped(acquireExclusive(sentinel, { timeoutMs: 0 }));
    const shared = Effect.scoped(acquireShared(sentinel, { timeoutMs: 0 }));
    try {
      await Effect.runPromise(exclusive); // Initialize the real FFI and filesystem runtime before measuring.
      const baseline = fdCount();
      await Effect.runPromise(
        Effect.gen(function* () {
          for (let i = 0; i < cycles; i++) yield* exclusive;
          expect(fdCount()).toBe(baseline);

          yield* Effect.scoped(
            Effect.gen(function* () {
              yield* acquireExclusive(sentinel);
              for (let i = 0; i < cycles; i++) {
                const waiter = yield* Effect.forkChild(Effect.flip(exclusive));
                expect((yield* Fiber.join(waiter)).lockFailure).toBe("timeout");
              }
            }),
          );
          expect(fdCount()).toBe(baseline);

          const open = yield* Effect.promise(nativeLock);
          yield* Effect.scoped(
            Effect.gen(function* () {
              // A raw holder bypasses the local queue so each waiter opens a real contended fd.
              const holder = yield* Effect.acquireRelease(
                Effect.sync(() => open(sentinel)),
                (handle) => Effect.sync(handle.close),
              );
              expect(holder.tryLock("exclusive")).toBe("acquired");
              for (let i = 0; i < cycles; i++) {
                const probed = yield* Deferred.make<void>();
                const waiter = yield* Effect.forkChild(
                  Effect.scoped(
                    acquireAdvisoryLockAt(sentinel, "test", {
                      timeoutMs: 5_000,
                      privateFileAccess: {
                        enforce: lockTestAccess.enforce,
                        verify: () => Effect.runPromise(Effect.asVoid(Deferred.succeed(probed, undefined))),
                      },
                    }),
                  ),
                );
                yield* Deferred.await(probed).pipe(Effect.timeout(2_000));
                yield* Fiber.interrupt(waiter);
                expect(Exit.hasInterrupts(yield* Fiber.await(waiter))).toBe(true);
              }
            }),
          );
          expect(fdCount()).toBe(baseline);

          for (let i = 0; i < cycles; i++) yield* shared;
          expect(fdCount()).toBe(baseline);
        }).pipe(Effect.timeout(9_000)),
      );
    } finally {
      await removeDir(dir);
    }
  },
  10_000,
);

for (const phase of ["opened", "locked", "recorded"] as const) {
  // Windows does not deliver POSIX SIGKILL.
  test.skipIf(process.platform === "win32")(
    `SIGKILL at ${phase} permits a first-probe acquire`,
    async () => {
      const dir = await tempLockDir();
      const sentinel = sentinelPath(dir);
      try {
        const holder = await spawnHolder(sourceHolderCommand(), sentinel, { pauseAt: phase });
        const exited = Effect.promise(() => holder.exited).pipe(Effect.timeout(2_000));
        try {
          if (phase === "recorded") {
            expect(peekAdvisoryLockRecord(sentinel)).toMatchObject({ pid: holder.pid, token: holder.token });
          } else {
            expect((await stat(sentinel)).size).toBe(0);
          }

          const probe = (await nativeLock())(sentinel);
          try {
            expect(probe.tryLock("exclusive")).toBe(phase === "opened" ? "acquired" : "contended");
          } finally {
            probe.close();
          }

          holder.process.kill("SIGKILL");
          await Effect.runPromise(exited);
          expect(holder.process.signalCode).toBe("SIGKILL");

          await runWithScope(
            Effect.gen(function* () {
              const events = yield* (yield* EventService).subscribeQueue;
              yield* acquireExclusive(sentinel, { timeoutMs: 0 });
              expect((yield* Queue.clear(events)).filter((event) => event._tag === "lock.wait")).toEqual([]);
            }).pipe(Effect.provide(capturingEventLayer([]))),
          );
        } finally {
          if (holder.process.exitCode === null && holder.process.signalCode === null) {
            holder.process.kill("SIGKILL");
            await Effect.runPromise(exited);
          }
        }
      } finally {
        await removeDir(dir);
      }
    },
    8_000,
  );
}
