import { mergeFailure, unscopedFailureReason } from "@lando/sdk/command-result";
import type { FailureRole } from "@lando/sdk/schema";
import { Cause, Effect, Exit, Result } from "effect";

export { mergeFailure };

/** Reify only ordinary failures; preserve exceptional reasons and their roles. */
export const settleOrdinaryFailure = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<Result.Result<A, E>, E, R> =>
  effect.pipe(
    Effect.map(Result.succeed),
    Effect.catchCause((cause) => {
      const reason = unscopedFailureReason(cause);
      return reason !== undefined && Cause.isFailReason(reason)
        ? Effect.succeed(Result.fail(reason.error))
        : Effect.failCause(cause);
    }),
  );

export const mapFailureErrors =
  <E, E2>(map: (error: E) => E2) =>
  <A, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E2, R> =>
    effect.pipe(Effect.catchCause((cause) => Effect.failCause(Cause.map(cause, map))));

export const runAllAndMergeFailures = Effect.fn("Lifecycle.runAllAndMergeFailures")(function* <E, R>(
  effects: ReadonlyArray<Effect.Effect<void, E, R>>,
): Effect.fn.Return<void, E, R> {
  const causes: Array<Cause.Cause<E>> = [];
  for (const effect of effects) {
    const exit = yield* Effect.exit(effect);
    if (Exit.isFailure(exit)) causes.push(exit.cause);
  }
  const first = causes[0];
  if (first === undefined) return;
  yield* Effect.failCause(
    causes.slice(1).reduce((previous, next) => mergeFailure(previous, next, "peer"), first),
  );
});

export const compensateFailure = <A, E, R, CleanupError, CleanupServices>(
  effect: Effect.Effect<A, E, R>,
  cleanup: Effect.Effect<void, CleanupError, CleanupServices>,
  role: FailureRole = "rollback",
): Effect.Effect<A, E | CleanupError, R | CleanupServices> =>
  Effect.matchCauseEffect(effect, {
    onSuccess: Effect.succeed,
    onFailure: (failureCause) =>
      Effect.matchCauseEffect(cleanup, {
        onSuccess: () => Effect.failCause(failureCause),
        onFailure: (cleanupCause) => Effect.failCause(mergeFailure(failureCause, cleanupCause, role)),
      }),
  });
