import { Effect } from "effect";

export const makeLockReentryGuard = () => {
  const active = new Set<string>();

  return Effect.fnUntraced(function* (path: string) {
    const fiberId = yield* Effect.fiberId;
    const key = `${fiberId}:${path}`;
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        if (active.has(key))
          throw new Error(
            `Fiber already holds the advisory lock for ${path}. Same-fiber lock re-entry would deadlock; this is a Lando bug.`,
          );
        active.add(key);
      }),
      () => Effect.sync(() => void active.delete(key)),
    );
  });
};
