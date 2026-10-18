import { FailureRoleAnnotation } from "@lando/sdk/command-result";
import type { FailureRole } from "@lando/sdk/schema";
import { Cause, Context, Effect, Exit, Option } from "effect";
import { isReadinessInterruptCause } from "./readiness-failure.ts";

export const mergeFailure = <E, E2>(
  primary: Cause.Cause<E>,
  secondary: Cause.Cause<E2>,
  role: FailureRole,
): Cause.Cause<E | E2> =>
  Cause.combine(
    primary,
    Cause.fromReasons(
      secondary.reasons.map((reason) => {
        const existing = Context.getOrUndefined(Cause.reasonAnnotations(reason), FailureRoleAnnotation);
        return existing === undefined || existing === "peer"
          ? reason.annotate(Context.make(FailureRoleAnnotation, role), { overwrite: true })
          : reason;
      }),
    ),
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

export const compensateFailureUnless = <A, E, R, CleanupError, CleanupServices>(
  effect: Effect.Effect<A, E, R>,
  cleanup: Effect.Effect<void, CleanupError, CleanupServices>,
  skip: (error: E) => boolean,
): Effect.Effect<A, E | CleanupError, R | CleanupServices> =>
  Effect.matchCauseEffect(effect, {
    onSuccess: Effect.succeed,
    onFailure: (failureCause) => {
      const failed = Cause.findErrorOption(failureCause);
      if (isReadinessInterruptCause(failureCause) || (Option.isSome(failed) && skip(failed.value))) {
        return Effect.failCause(failureCause);
      }
      return Effect.matchCauseEffect(cleanup, {
        onSuccess: () => Effect.failCause(failureCause),
        onFailure: (cleanupCause) => Effect.failCause(mergeFailure(failureCause, cleanupCause, "rollback")),
      });
    },
  });

export const compensateFailure = <A, E, R, CleanupError, CleanupServices>(
  effect: Effect.Effect<A, E, R>,
  cleanup: Effect.Effect<void, CleanupError, CleanupServices>,
): Effect.Effect<A, E | CleanupError, R | CleanupServices> =>
  compensateFailureUnless(effect, cleanup, () => false);
