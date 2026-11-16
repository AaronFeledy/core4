import { type Effect, Semaphore } from "effect";

/**
 * One in-process transaction gate per coordination key. The StateStore lock is
 * reentrant for a fiber that already holds the key, so two child fibers under one
 * holder would otherwise run volume transactions concurrently. This gate is not
 * reentrant: DataMover takes it around each whole provider volume transaction and
 * never nests one key inside itself, so a second fiber waits instead of joining.
 */
const gates = new Map<string, Semaphore.Semaphore>();

const gateFor = (coordinationKey: string): Semaphore.Semaphore => {
  const existing = gates.get(coordinationKey);
  if (existing !== undefined) return existing;
  const created = Semaphore.makeUnsafe(1);
  gates.set(coordinationKey, created);
  return created;
};

/** Serialize one provider volume transaction for a coordination key. */
export const withVolumeTransaction = <A, E, R>(
  coordinationKey: string,
  body: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => gateFor(coordinationKey).withPermits(1)(body);

/** Serialize several keys in sorted order; callers pass every key the transaction touches. */
export const withVolumeTransactions = <A, E, R>(
  coordinationKeys: ReadonlyArray<string>,
  body: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => {
  const keys = [...new Set(coordinationKeys)].sort();
  const acquire = (index: number): Effect.Effect<A, E, R> => {
    const key = keys[index];
    return key === undefined ? body : withVolumeTransaction(key, acquire(index + 1));
  };
  return acquire(0);
};
