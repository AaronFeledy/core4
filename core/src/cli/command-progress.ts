import { Context, Effect } from "effect";

/** Await retirement of this invocation's event-rendering consumer, not its Renderer service. */
export const FinishCommandProgress = Context.Reference<Effect.Effect<void>>(
  "@lando/core/FinishCommandProgress",
  {
    defaultValue: () => Effect.void,
  },
);

export const finishCommandProgress = Effect.fnUntraced(function* () {
  const finish = yield* FinishCommandProgress;
  yield* finish;
});

export interface CommandProgressSuspension {
  /**
   * Run `body` while an external program (sudo's password prompt) owns the terminal. Everything
   * published before the call is on screen first, nothing is drawn while `body` runs, and later
   * progress renders live again. A task tree that is still open cannot resume, so it retires
   * progress for the rest of the run instead.
   */
  readonly suspend: <A, E, R>(body: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}

export const SuspendCommandProgress = Context.Reference<CommandProgressSuspension>(
  "@lando/core/SuspendCommandProgress",
  { defaultValue: () => ({ suspend: (body) => body }) },
);

export const suspendCommandProgress = <A, E, R>(body: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.flatMap(SuspendCommandProgress, (progress) => progress.suspend(body));
