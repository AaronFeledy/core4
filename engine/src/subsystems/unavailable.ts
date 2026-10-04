import { Effect } from "effect";

export const UNAVAILABLE_ID = "unavailable" as const;

export const unavailableOperation =
  <Args extends ReadonlyArray<unknown>, E>(
    error: (...args: Args) => E,
  ): ((...args: Args) => Effect.Effect<never, E>) =>
  (...args) =>
    Effect.fail(error(...args));
