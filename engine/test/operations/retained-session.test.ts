import { expect, test } from "bun:test";
import { Cause, Deferred, Effect, Exit, Fiber, Schema, Scope } from "effect";
import { type PublishSession, withRetainedSession } from "../../src/operations/retained-session.ts";

const publishing =
  <Resource>(resource: Resource) =>
  (publish: PublishSession<Resource>) =>
    publish(resource).pipe(Effect.as(resource));

class UseError extends Schema.TaggedError<UseError>()("UseError", {}) {}

test.each([false, true])(
  "publication retains ownership when acquire completion interrupts, managed=%s",
  async (managed) => {
    // Given an acquisition that validates, records, and publishes its resource in one uninterruptible step.
    const scope = await Effect.runPromise(Scope.make());
    const ready = Deferred.makeUnsafe<void>();
    let closed = 0;
    let published = false;
    const acquire = (publish: PublishSession<string>): Effect.Effect<string> =>
      Deferred.await(ready).pipe(
        Effect.andThen(
          Effect.uninterruptible(
            Effect.sync(() => {
              published = true;
            }).pipe(
              Effect.andThen(publish("validated-recorded-session")),
              Effect.andThen(Effect.sync(() => fiber.interruptUnsafe())),
              Effect.as("validated-recorded-session"),
            ),
          ),
        ),
      );
    const fiber: Fiber.Fiber<never> = Effect.runFork(
      withRetainedSession(acquire, () => Effect.never, {
        ...(managed ? { scope } : {}),
        close: () =>
          Effect.sync(() => {
            closed++;
          }),
      }),
    );
    // When cancellation lands at the successful acquisition boundary.
    await Effect.runPromise(Deferred.succeed(ready, undefined));
    const exit = await Effect.runPromise(Fiber.await(fiber));
    const closedBeforeOwner = closed;
    await Effect.runPromise(Scope.close(scope, Exit.void));
    await Effect.runPromise(Scope.close(scope, Exit.void));
    // Then the published resource survives cancellation and its owner closes it once.
    expect(published).toBe(true);
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    expect(closedBeforeOwner).toBe(0);
    expect(closed).toBe(managed ? 1 : 0);
  },
);

test("cancels an unfinished acquisition without waiting for an external handshake", async () => {
  // Given an acquisition whose handshake has not returned a reusable resource.
  const entered = Deferred.makeUnsafe<void>();
  const finish = Deferred.makeUnsafe<string>();
  const cancelled = Deferred.makeUnsafe<void>();
  let used = false;
  const fiber = Effect.runFork(
    withRetainedSession(
      () =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(finish)),
          Effect.onInterrupt(() => Deferred.succeed(cancelled, undefined)),
        ),
      () =>
        Effect.sync(() => {
          used = true;
        }),
      { close: () => Effect.void },
    ),
  );
  // When cancellation arrives while the external handshake is blocked.
  await Effect.runPromise(Deferred.await(entered));
  fiber.interruptUnsafe();
  await Effect.runPromise(Effect.yieldNow);
  const interruptedBeforeHandshake = await Effect.runPromise(Deferred.isDone(cancelled));
  await Effect.runPromise(Deferred.succeed(finish, "session"));
  const exit = await Effect.runPromise(Fiber.await(fiber));
  // Then cancellation completes without using a resource or waiting for that handshake.
  expect(interruptedBeforeHandshake).toBe(true);
  expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
  expect(used).toBe(false);
});

test("retains detached success without constructing close", async () => {
  // Given
  let closed = 0;
  const operation = withRetainedSession(publishing("session"), Effect.succeed, {
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
    withRetainedSession(publishing("session"), Effect.succeed, { close, scope }),
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
  test(`retains on ${label} preserving the original Cause until its owner closes`, async () => {
    // Given
    const scope = await Effect.runPromise(Scope.make());
    let closed = 0;
    // When
    const exit = await Effect.runPromiseExit(
      withRetainedSession(publishing("session"), () => Effect.failCause(cause), {
        scope,
        close: () =>
          Effect.sync(() => {
            closed++;
          }),
      }),
    );
    const closedBeforeScope = closed;
    await Effect.runPromise(Scope.close(scope, Exit.void));
    // Then
    expect(exit).toEqual(Exit.failCause(cause));
    expect(closedBeforeScope).toBe(0);
    expect(closed).toBe(1);
  });
}

test("retains interrupted use until its owner closes exactly once", async () => {
  // Given
  const scope = await Effect.runPromise(Scope.make());
  const entered = Deferred.makeUnsafe<void>();
  let closed = 0;
  const fiber = Effect.runFork(
    withRetainedSession(
      publishing("session"),
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
  const closedBeforeScope = closed;
  await Effect.runPromise(Scope.close(scope, Exit.void));
  // Then
  expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
  expect(closedBeforeScope).toBe(0);
  expect(closed).toBe(1);
});

test("closes a session published to an already closed owner once acquisition returns", async () => {
  // Given an owner that closed before the acquisition (which may hold a worker lock) publishes.
  const scope = await Effect.runPromise(Scope.make());
  await Effect.runPromise(Scope.close(scope, Exit.void));
  let closed = 0;
  let closedInsideAcquisition = -1;
  // When
  const result = await Effect.runPromise(
    withRetainedSession(
      (publish: PublishSession<string>) =>
        publishing("session")(publish).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              closedInsideAcquisition = closed;
            }),
          ),
        ),
      Effect.succeed,
      {
        scope,
        close: () =>
          Effect.sync(() => {
            closed++;
          }),
      },
    ),
  );
  // Then the session closes exactly once, only after acquisition finished.
  expect(result).toBe("session");
  expect(closedInsideAcquisition).toBe(0);
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
    withRetainedSession(publishing("session"), Effect.succeed, {
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
