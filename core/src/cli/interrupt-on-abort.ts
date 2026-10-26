import { Effect, Fiber } from "effect";

export const interruptOnAbort = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  signal: AbortSignal | undefined,
): Effect.Effect<A, E, R> =>
  signal === undefined
    ? effect
    : Effect.gen(function* () {
        if (signal.aborted) return yield* Effect.interrupt;
        const fiber = yield* Effect.forkChild(effect);
        const abort = () => fiber.interruptUnsafe(fiber.id);
        return yield* Effect.acquireUseRelease(
          Effect.sync(() => {
            signal.addEventListener("abort", abort, { once: true });
            if (signal.aborted) abort();
          }),
          () => Fiber.join(fiber),
          () => Effect.sync(() => signal.removeEventListener("abort", abort)),
        );
      });
