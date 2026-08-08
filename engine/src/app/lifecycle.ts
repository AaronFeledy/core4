import { Effect, ExecutionStrategy, Exit, Ref, Scope } from "effect";

/**
 * Per-handle lifecycle controller. It owns a single managed start scope under
 * the handle scope, serializes lifecycle mutations through a mutex, and closes
 * managed scopes exactly once. Scope/ref mutations run uninterruptibly so an
 * interrupt between forking and recording (or during cleanup) cannot leak a
 * forked scope.
 */
export interface AppLifecycle {
  readonly serialize: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  readonly current: Effect.Effect<Scope.CloseableScope | undefined>;
  readonly closeCurrent: Effect.Effect<void>;
  readonly installFresh: Effect.Effect<Scope.CloseableScope>;
  readonly forgetIfCurrent: (scope: Scope.CloseableScope) => Effect.Effect<void>;
  readonly discardIfCurrent: (scope: Scope.CloseableScope) => Effect.Effect<void>;
}

export const makeAppLifecycle = (handleScope: Scope.Scope): Effect.Effect<AppLifecycle> =>
  Effect.gen(function* () {
    const mutex = yield* Effect.makeSemaphore(1);
    const current = yield* Ref.make<Scope.CloseableScope | undefined>(undefined);

    const closeCurrent: Effect.Effect<void> = Ref.getAndSet(current, undefined).pipe(
      Effect.flatMap((prev) => (prev === undefined ? Effect.void : Scope.close(prev, Exit.void))),
      Effect.uninterruptible,
    );

    const installFresh: Effect.Effect<Scope.CloseableScope> = Scope.fork(
      handleScope,
      ExecutionStrategy.sequential,
    ).pipe(
      Effect.tap((scope) => Ref.set(current, scope)),
      Effect.uninterruptible,
    );

    const forgetIfCurrent = (scope: Scope.CloseableScope): Effect.Effect<void> =>
      Ref.get(current).pipe(
        Effect.flatMap((value) => (value === scope ? Ref.set(current, undefined) : Effect.void)),
        Effect.uninterruptible,
      );

    const discardIfCurrent = (scope: Scope.CloseableScope): Effect.Effect<void> =>
      Ref.get(current).pipe(
        Effect.flatMap((value) =>
          value === scope
            ? Ref.set(current, undefined).pipe(Effect.zipRight(Scope.close(scope, Exit.void)))
            : Effect.void,
        ),
        Effect.uninterruptible,
      );

    return {
      serialize: (effect) => mutex.withPermits(1)(effect),
      current: Ref.get(current),
      closeCurrent,
      installFresh,
      forgetIfCurrent,
      discardIfCurrent,
    };
  });
