import { Effect } from "effect";

const abortEffect = (signal: AbortSignal): Effect.Effect<never> =>
  Effect.async<never>((resume) => {
    if (signal.aborted) {
      resume(Effect.interrupt);
      return;
    }
    const abort = () => resume(Effect.interrupt);
    signal.addEventListener("abort", abort, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", abort));
  });

export const interruptOnAbort = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  signal: AbortSignal | undefined,
): Effect.Effect<A, E, R> => (signal === undefined ? effect : Effect.raceFirst(effect, abortEffect(signal)));
