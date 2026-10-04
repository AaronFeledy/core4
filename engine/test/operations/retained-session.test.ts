import { expect, test } from "bun:test";
import { Cause, Deferred, Effect, Exit, Fiber, Schema, Scope } from "effect";
import { withRetainedSession } from "../../src/operations/retained-session.ts";

class UseError extends Schema.TaggedError<UseError>()("UseError", {}) {}

test("retains detached success without constructing close", async () => {
  // Given
  let closed = 0;
  const operation = withRetainedSession(Effect.succeed("session"), Effect.succeed, {
    close: () => {
      closed++;
      return Effect.void;
    },
  });
  // When
  const result = await Effect.runPromise(operation);
  // Then
  expect(result).toBe("session");
  expect(closed).toBe(0);
});

test("hands managed success to the scope until it closes", async () => {
  // Given
  const scope = await Effect.runPromise(Scope.make());
  let closed = 0;
  const close = () =>
    Effect.sync(() => {
      closed++;
    });
  // When
  const result = await Effect.runPromise(
    withRetainedSession(Effect.succeed("session"), Effect.succeed, { close, scope }),
  );
  const closedBeforeScope = closed;
  await Effect.runPromise(Scope.close(scope, Exit.void));
  // Then
  expect(result).toBe("session");
  expect(closedBeforeScope).toBe(0);
  expect(closed).toBe(1);
});

for (const [label, cause] of [
  ["typed failure", Cause.fail(new UseError())],
  ["defect", Cause.die(new TypeError("use defect"))],
] as const) {
  test(`closes on ${label} preserving the original Cause without scope ownership`, async () => {
    // Given
    const scope = await Effect.runPromise(Scope.make());
    let closed = 0;
    // When
    const exit = await Effect.runPromiseExit(
      withRetainedSession(Effect.succeed("session"), () => Effect.failCause(cause), {
        scope,
        close: () =>
          Effect.sync(() => {
            closed++;
          }),
      }),
    );
    await Effect.runPromise(Scope.close(scope, Exit.void));
    // Then
    expect(exit).toEqual(Exit.failCause(cause));
    expect(closed).toBe(1);
  });
}

test("closes exactly once when actual use is interrupted", async () => {
  // Given
  const scope = await Effect.runPromise(Scope.make());
  const entered = Deferred.makeUnsafe<void>();
  let closed = 0;
  const fiber = Effect.runFork(
    withRetainedSession(
      Effect.succeed("session"),
      () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
      {
        scope,
        close: () =>
          Effect.sync(() => {
            closed++;
          }),
      },
    ),
  );
  // When
  await Effect.runPromise(Deferred.await(entered));
  const exit = await Effect.runPromise(Fiber.interrupt(fiber).pipe(Effect.andThen(Fiber.await(fiber))));
  await Effect.runPromise(Scope.close(scope, Exit.void));
  // Then
  expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
  expect(closed).toBe(1);
});

test("closes successful use immediately when the managed scope is already closed", async () => {
  // Given
  const scope = await Effect.runPromise(Scope.make());
  await Effect.runPromise(Scope.close(scope, Exit.void));
  let closed = 0;
  // When
  const result = await Effect.runPromise(
    withRetainedSession(Effect.succeed("session"), Effect.succeed, {
      scope,
      close: () =>
        Effect.sync(() => {
          closed++;
        }),
    }),
  );
  // Then
  expect(result).toBe("session");
  expect(closed).toBe(1);
});

test("finishes immediate finalization exactly once despite interruption during handoff", async () => {
  // Given
  const scope = await Effect.runPromise(Scope.make());
  await Effect.runPromise(Scope.close(scope, Exit.void));
  const entered = Deferred.makeUnsafe<void>();
  const finish = Deferred.makeUnsafe<void>();
  let started = 0;
  let closed = 0;
  const fiber = Effect.runFork(
    withRetainedSession(Effect.succeed("session"), Effect.succeed, {
      scope,
      close: () =>
        Effect.gen(function* () {
          started++;
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(finish);
          closed++;
        }),
    }),
  );
  // When
  await Effect.runPromise(Deferred.await(entered));
  fiber.interruptUnsafe();
  await Effect.runPromise(Deferred.succeed(finish, undefined));
  const exit = await Effect.runPromise(Fiber.await(fiber));
  // Then
  expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
  expect(started).toBe(1);
  expect(closed).toBe(1);
});
