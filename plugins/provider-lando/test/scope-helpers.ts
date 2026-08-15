import { Effect, type Scope } from "effect";

export const runScoped = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(effect));

export const runScopedExit = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) =>
  Effect.runPromiseExit(Effect.scoped(effect));
