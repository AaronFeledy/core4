import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { Deferred, Effect, Fiber, Ref } from "effect";

import { withProcessCwd } from "../../src/runtime/process-cwd.ts";

const cwdError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error("Unable to change the process working directory.");

describe("withProcessCwd", () => {
  test("allows nested cwd regions in one fiber and restores each root", async () => {
    const outer = await realpath(await mkdtemp(join(tmpdir(), "lando-cwd-outer-")));
    const inner = await realpath(await mkdtemp(join(tmpdir(), "lando-cwd-inner-")));
    const original = process.cwd();

    try {
      const observed = await Effect.runPromise(
        withProcessCwd(
          outer,
          Effect.gen(function* () {
            const outerBefore = process.cwd();
            const nested = yield* withProcessCwd(
              inner,
              Effect.sync(() => process.cwd()),
              cwdError,
            );
            return { outerBefore, nested, outerAfter: process.cwd() };
          }),
          cwdError,
        ),
      );

      expect(observed).toEqual({ outerBefore: outer, nested: inner, outerAfter: outer });
      expect(process.cwd()).toBe(original);
    } finally {
      await rm(outer, { recursive: true, force: true });
      await rm(inner, { recursive: true, force: true });
    }
  });

  test("serializes a same-root cwd region against another fiber", async () => {
    const firstRoot = process.cwd();
    const secondRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-cwd-second-")));

    try {
      const order = await Effect.runPromise(
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const events = yield* Ref.make<ReadonlyArray<string>>([]);
          const first = yield* Effect.fork(
            withProcessCwd(
              firstRoot,
              Ref.update(events, (items) => [...items, `enter:${process.cwd()}`]).pipe(
                Effect.zipRight(Deferred.succeed(entered, undefined)),
                Effect.zipRight(Deferred.await(release)),
                Effect.zipRight(Ref.update(events, (items) => [...items, `exit:${process.cwd()}`])),
              ),
              cwdError,
            ),
          );
          yield* Deferred.await(entered);
          const second = yield* Effect.fork(
            withProcessCwd(
              secondRoot,
              Ref.update(events, (items) => [...items, `enter:${process.cwd()}`]),
              cwdError,
            ),
          );
          yield* Effect.yieldNow();
          expect(yield* Ref.get(events)).toEqual([`enter:${firstRoot}`]);
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(first);
          yield* Fiber.join(second);
          return yield* Ref.get(events);
        }),
      );

      expect(order).toEqual([`enter:${firstRoot}`, `exit:${firstRoot}`, `enter:${secondRoot}`]);
    } finally {
      await rm(secondRoot, { recursive: true, force: true });
    }
  });
});
