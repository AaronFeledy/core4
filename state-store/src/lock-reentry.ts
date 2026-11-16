import { Effect, type Semaphore } from "effect";

export const makeLockReentryGuard = () => {
  // Semaphores are not reentrant: waiting on a permit held by this fiber would deadlock.
  const lockHolders = new Map<string, number>();

  return Effect.fnUntraced(function* <A, E, R, LockError>(
    file: string,
    body: Effect.Effect<A, E, R>,
    lock: {
      readonly semaphore: Semaphore.Semaphore;
      readonly path: string;
      readonly acquire: Effect.Effect<void, LockError>;
      readonly release: Effect.Effect<void>;
    },
  ): Effect.fn.Return<A, E | LockError, R> {
    const fiberId = yield* Effect.fiberId;
    if (lockHolders.get(file) === fiberId)
      return yield* Effect.die(
        new Error(
          `Fiber already holds the advisory lock for ${lock.path}. A same-fiber lock re-entry would deadlock; this is a Lando bug.`,
        ),
      );
    return yield* lock.semaphore.withPermits(1)(
      Effect.suspend(() => {
        // Recorded as soon as the permit is held, so a re-entry made while still acquiring (from a
        // wait hook) dies too instead of waiting on this fiber's own permit.
        lockHolders.set(file, fiberId);
        return Effect.acquireUseRelease(
          lock.acquire,
          () => body,
          () => lock.release,
        );
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (lockHolders.get(file) === fiberId) lockHolders.delete(file);
          }),
        ),
      ),
    );
  });
};
