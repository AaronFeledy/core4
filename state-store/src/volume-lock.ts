import type { StateStoreError } from "@lando/sdk/errors";
import { type StateLockOptions, type StateStoreShape, physicalVolumeLockKey } from "@lando/sdk/services";
import { Clock, Context, Effect } from "effect";

import { resolveOperationLockTimeoutMs } from "./lock.ts";

export type VolumeLockMode = "exclusive" | "shared";

/**
 * Coordination keys whose advisory lock this fiber already holds, with the mode
 * acquired. Only the lock functions below provide it; forked children inherit it,
 * so work started under a lock stays reentrant. Shared is satisfied by any held
 * mode; exclusive on a shared-held key is a defect (no upgrades).
 */
export const heldVolumeLocks: Context.Reference<ReadonlyMap<string, VolumeLockMode>> = Context.Reference<
  ReadonlyMap<string, VolumeLockMode>
>("@lando/state-store/HeldVolumeLocks", {
  defaultValue: (): ReadonlyMap<string, VolumeLockMode> => new Map(),
});

export type VolumeLockRequest = {
  readonly key: string;
  readonly mode?: VolumeLockMode;
  readonly resource?: string;
};

type LockingStateStore = Pick<StateStoreShape, "withLock">;

const modeOf = (request: VolumeLockRequest): VolumeLockMode => request.mode ?? "exclusive";

const resourceOf = (request: VolumeLockRequest): string =>
  (request.resource ?? `volume ${request.key}`).slice(0, 512);

/** Strongest mode wins when the same key appears more than once. */
const dedupeRequests = (requests: ReadonlyArray<VolumeLockRequest>): ReadonlyArray<VolumeLockRequest> => {
  const strongest = new Map<string, VolumeLockRequest>();
  for (const request of requests) {
    const mode = modeOf(request);
    const prior = strongest.get(request.key);
    if (prior === undefined || (mode === "exclusive" && modeOf(prior) === "shared")) {
      strongest.set(request.key, { ...request, mode });
    }
  }
  return [...strongest.values()].sort((left, right) =>
    left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
  );
};

const normalizeRequests = (
  keys: ReadonlyArray<string | VolumeLockRequest>,
): ReadonlyArray<VolumeLockRequest> =>
  dedupeRequests(keys.map((entry) => (typeof entry === "string" ? { key: entry } : entry)));

/** A held exclusive or shared lock satisfies a shared request; exclusive needs exclusive. */
export const holdsVolumeLock = (
  held: ReadonlyMap<string, VolumeLockMode>,
  request: VolumeLockRequest,
): boolean => {
  const current = held.get(request.key);
  if (current === undefined) return false;
  return modeOf(request) === "shared" || current === "exclusive";
};

const upgradeDefect = (key: string): Error =>
  new Error(
    `Volume lock upgrade refused: ${key} is held shared and an exclusive request cannot upgrade it. Acquire exclusive for every writer before shared readers nest under the same fiber; this is a Lando bug.`,
  );

/**
 * A nested expansion may only add keys above every key this fiber already holds.
 * Multi-key phases acquire their complete union up front, so a lower key proves a
 * new nesting site would invert the global lock order.
 */
const assertNestedLockOrder = (
  missing: ReadonlyArray<string>,
  held: ReadonlyMap<string, VolumeLockMode>,
): Effect.Effect<void> => {
  const firstMissing = missing[0];
  if (firstMissing === undefined || held.size === 0) return Effect.void;
  let highestHeld = "";
  for (const key of held.keys()) if (key > highestHeld) highestHeld = key;
  if (firstMissing > highestHeld) return Effect.void;
  return Effect.die(
    new Error(
      `Volume lock ordering violated: ${firstMissing} is not held and sorts below already-held ${highestHeld}. A lifecycle phase must acquire every volume key it will need in sorted order before it starts; this is a Lando bug.`,
    ),
  );
};

const withHeld = (
  held: ReadonlyMap<string, VolumeLockMode>,
  key: string,
  mode: VolumeLockMode,
): ReadonlyMap<string, VolumeLockMode> => {
  const next = new Map(held);
  const current = next.get(key);
  // Never weaken an exclusive hold to shared while nested work runs under it.
  next.set(key, current === "exclusive" ? "exclusive" : mode);
  return next;
};

const remainingBudgetMs = (deadlineNanos: bigint, nowNanos: bigint): number => {
  const remaining = Number(deadlineNanos - nowNanos) / 1_000_000;
  return Math.max(0, Math.floor(remaining));
};

/**
 * Take the physical-volume advisory lock for this coordination key, or enter
 * directly when this fiber already holds a compatible mode. The advisory lock
 * itself is not reentrant across fibers.
 */
export const withPhysicalVolumeLock = <A, E, R>(
  stateStore: LockingStateStore,
  coordinationKey: string | VolumeLockRequest,
  body: Effect.Effect<A, E, R>,
  options: Pick<StateLockOptions, "timeoutMs"> = {},
): Effect.Effect<A, E | StateStoreError, R> => {
  const request = typeof coordinationKey === "string" ? { key: coordinationKey } : coordinationKey;
  const mode = modeOf(request);
  return heldVolumeLocks.pipe(
    Effect.flatMap((held) => {
      if (holdsVolumeLock(held, request)) return body;
      if (held.has(request.key)) return Effect.die(upgradeDefect(request.key));
      const lockOptions: StateLockOptions = {
        wait: "operation",
        mode,
        resource: resourceOf(request),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      };
      return assertNestedLockOrder([request.key], held).pipe(
        Effect.andThen(
          stateStore.withLock(
            physicalVolumeLockKey(request.key),
            Effect.provideService(body, heldVolumeLocks, withHeld(held, request.key, mode)),
            lockOptions,
          ),
        ),
      );
    }),
  );
};

/**
 * Acquire several coordination keys in sorted order under one operation-length
 * deadline, skipping keys this fiber already holds in a compatible mode. Nested
 * expansions that would invert lock order die; exclusive requests on a shared-held
 * key die (no upgrades).
 */
export const withPhysicalVolumeLocks = Effect.fnUntraced(function* <A, E, R>(
  stateStore: LockingStateStore,
  coordinationKeys: ReadonlyArray<string | VolumeLockRequest>,
  body: Effect.Effect<A, E, R>,
): Effect.fn.Return<A, E | StateStoreError, R> {
  const held = yield* heldVolumeLocks;
  const requests = normalizeRequests(coordinationKeys);
  for (const request of requests) {
    if (held.has(request.key) && !holdsVolumeLock(held, request)) {
      return yield* Effect.die(upgradeDefect(request.key));
    }
  }
  const missing = requests.filter((request) => !holdsVolumeLock(held, request));
  yield* assertNestedLockOrder(
    missing.map((request) => request.key),
    held,
  );
  const budgetMs = resolveOperationLockTimeoutMs();
  const deadline = (yield* Clock.monotonicTimeNanos) + BigInt(budgetMs) * 1_000_000n;
  const lockAll = (index: number): Effect.Effect<A, E | StateStoreError, R> => {
    const request = missing[index];
    if (request === undefined) return body;
    return Clock.monotonicTimeNanos.pipe(
      Effect.flatMap((now) =>
        withPhysicalVolumeLock(stateStore, request, lockAll(index + 1), {
          timeoutMs: remainingBudgetMs(deadline, now),
        }),
      ),
    );
  };
  return yield* lockAll(0);
});
