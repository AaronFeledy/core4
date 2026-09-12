import { Cause, Effect, Exit, Option } from "effect";

export const runAllAndMergeFailures = <E, R>(
  effects: ReadonlyArray<Effect.Effect<void, E, R>>,
): Effect.Effect<void, E, R> =>
  Effect.gen(function* () {
    const causes: Array<Cause.Cause<E>> = [];
    for (const effect of effects) {
      const exit = yield* Effect.exit(effect);
      if (Exit.isFailure(exit)) causes.push(exit.cause);
    }
    const first = causes[0];
    if (first === undefined) return;
    yield* Effect.failCause(causes.slice(1).reduce(Cause.parallel, first));
  });

export const compensateFailureUnless = <A, E, R, CleanupError, CleanupServices>(
  effect: Effect.Effect<A, E, R>,
  cleanup: Effect.Effect<void, CleanupError, CleanupServices>,
  skip: (error: E) => boolean,
): Effect.Effect<A, E | CleanupError, R | CleanupServices> =>
  Effect.matchCauseEffect(effect, {
    onSuccess: Effect.succeed,
    onFailure: (failureCause) => {
      const failed = Cause.failureOption(failureCause);
      if (Option.isSome(failed) && skip(failed.value)) {
        return Effect.failCause(failureCause);
      }
      return Effect.matchCauseEffect(cleanup, {
        onSuccess: () => Effect.failCause(failureCause),
        onFailure: (cleanupCause) => Effect.failCause(Cause.parallel(failureCause, cleanupCause)),
      });
    },
  });

export const compensateFailure = <A, E, R, CleanupError, CleanupServices>(
  effect: Effect.Effect<A, E, R>,
  cleanup: Effect.Effect<void, CleanupError, CleanupServices>,
): Effect.Effect<A, E | CleanupError, R | CleanupServices> =>
  compensateFailureUnless(effect, cleanup, () => false);
