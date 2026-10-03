import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withResolvedCwd } from "@lando/landofile/app-resolution";
import { Deferred, Effect, Fiber, Result } from "effect";

const withDirectories = async <A>(
  run: (roots: { readonly outer: string; readonly inner: string }) => Promise<A>,
) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "lando-cwd-owner-fiber-")));
  const outer = join(root, "outer");
  const inner = join(root, "inner");
  await mkdir(outer);
  await mkdir(inner);
  try {
    return await run({ outer, inner });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};
const cwd = Effect.sync(() => process.cwd());

describe("resolved cwd fiber-local ownership", () => {
  test("same-fiber nested resolution reenters and restores each enclosing cwd", async () => {
    // Given
    const original = process.cwd();
    await withDirectories(async ({ outer, inner }) => {
      // When
      const results = await Effect.runPromise(
        Effect.gen(function* () {
          const before = yield* cwd;
          const bound = yield* withResolvedCwd(
            outer,
            Effect.gen(function* () {
              const first = yield* cwd;
              const nested = yield* withResolvedCwd(inner, cwd);
              return { first, nested, restored: yield* cwd };
            }),
          );
          return { before, ...bound, after: yield* cwd };
        }).pipe(Effect.timeout("2 seconds")),
      );
      // Then
      expect(results).toEqual({
        before: original,
        first: outer,
        nested: inner,
        restored: outer,
        after: original,
      });
    });
  });

  test("a child inherits the owner identity but cannot reenter its parent's cwd lock", async () => {
    // Given
    const original = process.cwd();
    await withDirectories(async ({ outer, inner }) => {
      // When
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const started = yield* Deferred.make<void>();
            const entered = yield* Deferred.make<void>();
            const held = yield* withResolvedCwd(
              outer,
              Effect.gen(function* () {
                const child = yield* Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(
                    withResolvedCwd(inner, Deferred.succeed(entered, undefined).pipe(Effect.andThen(cwd))),
                  ),
                  Effect.forkScoped,
                );
                yield* Deferred.await(started);
                yield* Effect.yieldNow;
                return { child, waiting: yield* Deferred.poll(entered), parentCwd: yield* cwd };
              }),
            );
            return {
              waiting: held.waiting,
              parentCwd: held.parentCwd,
              childCwd: yield* Fiber.join(held.child),
              after: yield* cwd,
            };
          }),
        ).pipe(Effect.timeout("2 seconds")),
      );
      // Then
      expect(result.waiting._tag).toBe("None");
      expect(result.parentCwd).toBe(outer);
      expect(result.childCwd).toBe(inner);
      expect(result.after).toBe(original);
    });
  });

  test("restores cwd ownership after a failing nested resolution", async () => {
    // Given
    const original = process.cwd();
    await withDirectories(async ({ outer, inner }) => {
      // When
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const failure = yield* withResolvedCwd(outer, withResolvedCwd(inner, Effect.fail("failed"))).pipe(
            Effect.result,
          );
          const afterFailure = yield* cwd;
          const next = yield* withResolvedCwd(inner, cwd);
          return { failure, afterFailure, next, restored: yield* cwd };
        }).pipe(Effect.timeout("2 seconds")),
      );
      // Then
      expect(result).toEqual({
        failure: Result.fail("failed"),
        afterFailure: original,
        next: inner,
        restored: original,
      });
    });
  });
});
