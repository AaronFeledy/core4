import { Semaphore } from "effect";
import { Effect, Exit, Ref, Scope } from "effect";

/**
 * Per-handle lifecycle controller. It owns a single managed start scope under
 * the handle scope, serializes lifecycle mutations through a mutex, and closes
 * managed scopes exactly once. Scope/ref mutations run uninterruptibly so an
 * interrupt between forking and recording (or during cleanup) cannot leak a
 * forked scope.
 */
export interface AppLifecycle {
  readonly serialize: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  readonly current: Effect.Effect<Scope.Closeable | undefined>;
  readonly closeCurrent: Effect.Effect<void>;
  readonly stageFresh: Effect.Effect<Scope.Closeable>;
  readonly replaceCurrent: (scope: Scope.Closeable) => Effect.Effect<void>;
  readonly discardStaged: (scope: Scope.Closeable) => Effect.Effect<void>;
}

export const makeAppLifecycle = Effect.fnUntraced(function* (
  handleScope: Scope.Scope,
): Effect.fn.Return<AppLifecycle> {
  const mutex = yield* Semaphore.make(1);
  const current = yield* Ref.make<Scope.Closeable | undefined>(undefined);

  const closeCurrent: Effect.Effect<void> = Ref.getAndSet(current, undefined).pipe(
    Effect.flatMap((prev) => (prev === undefined ? Effect.void : Scope.close(prev, Exit.void))),
    Effect.uninterruptible,
  );

  const stageFresh: Effect.Effect<Scope.Closeable> = Scope.fork(handleScope, "sequential").pipe(
    Effect.uninterruptible,
  );

  const replaceCurrent = (scope: Scope.Closeable): Effect.Effect<void> =>
    Ref.getAndSet(current, scope).pipe(
      Effect.flatMap((prev) => (prev === undefined ? Effect.void : Scope.close(prev, Exit.void))),
      Effect.uninterruptible,
    );

  const discardStaged = (scope: Scope.Closeable): Effect.Effect<void> =>
    Ref.get(current).pipe(
      Effect.flatMap((value) => (value === scope ? Effect.void : Scope.close(scope, Exit.void))),
      Effect.uninterruptible,
    );

  return {
    serialize: (effect) => mutex.withPermits(1)(effect),
    current: Ref.get(current),
    closeCurrent,
    stageFresh,
    replaceCurrent,
    discardStaged,
  };
});
