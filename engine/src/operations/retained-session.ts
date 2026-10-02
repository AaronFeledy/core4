import { Effect, Exit, Scope } from "effect";

/** Decide ownership in the masked release, using the use phase's captured exit. */
export const withRetainedSession = <Resource, A, E, R, E2, R2>(
  acquire: Effect.Effect<Resource, E, R>,
  use: (resource: Resource) => Effect.Effect<A, E2, R2>,
  options: {
    readonly close: (resource: Resource) => Effect.Effect<void>;
    readonly scope?: Scope.Scope;
  },
): Effect.Effect<A, E | E2, R | R2> =>
  Effect.acquireUseRelease(acquire, use, (resource, exit) => {
    if (Exit.isFailure(exit)) return Effect.suspend(() => options.close(resource));
    return options.scope === undefined
      ? Effect.void
      : Scope.addFinalizer(
          options.scope,
          Effect.suspend(() => options.close(resource)),
        );
  });
