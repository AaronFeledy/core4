import { describe, expect, test } from "bun:test";
import { AppId } from "@lando/sdk/schema";
import { Deferred, Effect, Result, Fiber } from "effect";
import { withinEventInvocation } from "../../src/operations/event-invocation.ts";

const frame = (id: string) => ({ app: AppId.make(id), event: "pre-start" as const, file: "/app/.lando.yml" });
const atDepth = (
  depth: number,
): Effect.Effect<
  string,
  | import("@lando/sdk/errors").LandofileEventInvocationDepthError
  | import("@lando/sdk/errors").LandofileEventLifecycleReentryError
> =>
  depth === 0
    ? Effect.succeed("completed")
    : withinEventInvocation(frame(`app-${depth}`), atDepth(depth - 1));

describe("event invocation fiber-local frames", () => {
  test("allows sixteen active events and restores an empty stack after success and failure", async () => {
    // Given / When
    const results = await Effect.runPromise(
      Effect.gen(function* () {
        const first = yield* atDepth(16);
        const failed = yield* withinEventInvocation(frame("failed"), Effect.fail("body-failed")).pipe(
          Effect.result,
        );
        const retry = yield* withinEventInvocation(frame("failed"), atDepth(15));
        return { first, failed, retry, after: yield* atDepth(16) };
      }),
    );
    // Then
    expect(results).toEqual({
      first: "completed",
      failed: Result.fail("body-failed"),
      retry: "completed",
      after: "completed",
    });
  });

  test("forked children inherit frames and reject reentry with the inherited chain", async () => {
    // Given / When
    const error = await Effect.runPromise(
      withinEventInvocation(
        frame("parent"),
        Effect.gen(function* () {
          const child = yield* Effect.forkChild(
            withinEventInvocation(frame("parent"), Effect.void).pipe(Effect.flip),
          );
          return yield* Fiber.join(child);
        }),
      ),
    );
    // Then
    expect(error).toMatchObject({
      _tag: "LandofileEventLifecycleReentryError",
      event: "pre-start",
      chain: ["pre-start", "pre-start"],
    });
  });

  test("forked children count inherited events toward the seventeenth-depth failure", async () => {
    // Given
    const work = withinEventInvocation(
      frame("parent"),
      Effect.gen(function* () {
        const child = yield* Effect.forkChild(atDepth(16).pipe(Effect.flip));
        return yield* Fiber.join(child);
      }),
    );
    // When
    const error = await Effect.runPromise(work);
    // Then
    expect(error).toMatchObject({ _tag: "LandofileEventInvocationDepthError", depth: 17, limit: 16 });
    expect(error.chain).toHaveLength(17);
  });

  test("overlapping siblings may enter the same app event without sharing frames", async () => {
    // Given / When
    const results = await Effect.runPromise(
      Effect.gen(function* () {
        const left = yield* Deferred.make<void>();
        const right = yield* Deferred.make<void>();
        return yield* Effect.all(
          [
            withinEventInvocation(
              frame("shared"),
              Deferred.succeed(left, undefined).pipe(
                Effect.andThen(Deferred.await(right)),
                Effect.andThen(atDepth(15)),
              ),
            ),
            withinEventInvocation(
              frame("shared"),
              Deferred.succeed(right, undefined).pipe(
                Effect.andThen(Deferred.await(left)),
                Effect.andThen(atDepth(15)),
              ),
            ),
          ],
          { concurrency: 2 },
        );
      }),
    );
    // Then
    expect(results).toEqual(["completed", "completed"]);
  });
});
