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
