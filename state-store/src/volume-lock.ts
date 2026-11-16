import type { StateStoreError } from "@lando/sdk/errors";
import { type StateStoreShape, physicalVolumeLockKey } from "@lando/sdk/services";
import { Context, Effect } from "effect";

/**
 * Coordination keys whose advisory lock this fiber already holds. Only the lock
 * functions below provide it; forked children inherit it, so work started under
 * a lock stays reentrant.
 */
export const heldVolumeLocks: Context.Reference<ReadonlySet<string>> = Context.Reference<ReadonlySet<string>>(
  "@lando/state-store/HeldVolumeLocks",
  {
    defaultValue: (): ReadonlySet<string> => new Set(),
  },
);

type LockingStateStore = Pick<StateStoreShape, "withLock">;

/**
 * Take the physical-volume advisory lock for this coordination key, or enter
 * directly when this fiber already holds it; the advisory lock itself is not reentrant.
 */
export const withPhysicalVolumeLock = <A, E, R>(
  stateStore: LockingStateStore,
  coordinationKey: string,
  body: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | StateStoreError, R> =>
  heldVolumeLocks.pipe(
    Effect.flatMap((held) =>
      held.has(coordinationKey)
        ? body
        : stateStore.withLock(
            physicalVolumeLockKey(coordinationKey),
            Effect.provideService(body, heldVolumeLocks, new Set([...held, coordinationKey])),
          ),
    ),
  );

/** Acquire several coordination keys in sorted order, skipping keys this fiber already holds. */
export const withPhysicalVolumeLocks = Effect.fnUntraced(function* <A, E, R>(
  stateStore: LockingStateStore,
  coordinationKeys: ReadonlyArray<string>,
  body: Effect.Effect<A, E, R>,
): Effect.fn.Return<A, E | StateStoreError, R> {
  const held = yield* heldVolumeLocks;
  const missing = [...new Set(coordinationKeys)].filter((key) => !held.has(key)).sort();
  const lockAll = (index: number): Effect.Effect<A, E | StateStoreError, R> => {
    const key = missing[index];
    return key === undefined ? body : withPhysicalVolumeLock(stateStore, key, lockAll(index + 1));
  };
  return yield* lockAll(0);
});
