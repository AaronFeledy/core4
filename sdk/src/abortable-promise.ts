import { Effect } from "effect";

/**
 * Like Effect.tryPromise, but joins aborted work before interruption completes.
 * This lets promise cleanup finish before scoped staging directories and leases close.
 * Pending work is tracked separately for each execution of the effect.
 */
export const tryPromiseSettled = <A, E>(options: {
  readonly try: (signal: AbortSignal) => PromiseLike<A>;
  readonly catch: (cause: unknown) => E;
}): Effect.Effect<A, E> =>
  Effect.suspend(() => {
    let running: PromiseLike<A> | undefined;
    return Effect.tryPromise({
      try: (signal) => {
        running = options.try(signal);
        return running;
      },
      catch: options.catch,
    }).pipe(
      Effect.onInterrupt(() =>
        Effect.promise(async () => {
          if (running !== undefined) await Promise.allSettled([running]);
        }),
      ),
    );
  });
