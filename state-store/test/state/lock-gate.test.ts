import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deferred, Effect, Fiber } from "effect";
import { acquireExclusive, acquireShared, capturingEventLayer, sentinelPath } from "./native-lock-support.ts";

test("a later reader cannot bypass a queued writer, but can enter once it is interrupted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lando-state-lock-gate-"));
  const path = sentinelPath(dir, "shared");
  const writerWaiting = Deferred.makeUnsafe<void>();
  const tryReader = Effect.scoped(acquireShared(path, { timeoutMs: 0 })).pipe(
    Effect.forkChild,
    Effect.flatMap(Fiber.join),
  );
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* acquireShared(path);
          const writer = yield* Effect.forkChild(
            Effect.scoped(acquireExclusive(path, { wait: "operation", timeoutMs: 10_000 })),
          );
          yield* Deferred.await(writerWaiting).pipe(Effect.timeout("3 seconds"));

          const failure = yield* Effect.flip(tryReader);
          expect(failure.lockFailure).toBe("timeout");
          yield* Fiber.interrupt(writer);
          yield* tryReader;
        }),
      ).pipe(Effect.provide(capturingEventLayer([], () => Deferred.succeed(writerWaiting, undefined)))),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
