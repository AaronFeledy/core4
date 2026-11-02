import { Effect, Scope } from "effect";

/** Hands an acquired resource to its owner; acquisition calls it in the same uninterruptible step that publishes the resource. */
export type PublishSession<Resource> = (resource: Resource) => Effect.Effect<void>;

/**
 * Publish ownership at acquisition; later failures and cancellation leave the published session owned.
 * Without a scope (CLI detached ownership) start never closes the session.
 */
export const withRetainedSession = <Resource, A, E, R, E2, R2>(
  acquire: (publish: PublishSession<Resource>) => Effect.Effect<Resource, E, R>,
  use: (resource: Resource) => Effect.Effect<A, E2, R2>,
  options: {
    readonly close: (resource: Resource) => Effect.Effect<void>;
    readonly scope?: Scope.Scope;
  },
): Effect.Effect<A, E | E2, R | R2> =>
  Effect.suspend(() => {
    const { scope, close } = options;
    // An owner that already closed cannot take a finalizer; close after acquisition releases its locks.
    const ownerless: Array<Resource> = [];
    const publish: PublishSession<Resource> = (resource) =>
      scope === undefined
        ? Effect.void
        : Effect.suspend(() => {
            if (scope.state._tag !== "Closed")
              return Scope.addFinalizer(
                scope,
                Effect.suspend(() => close(resource)),
              );
            ownerless.push(resource);
            return Effect.void;
          });
    return Effect.uninterruptibleMask((restore) =>
      restore(acquire(publish)).pipe(
        Effect.ensuring(Effect.suspend(() => Effect.forEach(ownerless.splice(0), close, { discard: true }))),
        Effect.flatMap((resource) => restore(use(resource))),
      ),
    );
  });
