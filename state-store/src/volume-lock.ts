import type { StateStoreError } from "@lando/sdk/errors";
import { physicalVolumeLockTier } from "@lando/sdk/schema";
import { type StateLockOptions, type StateStoreShape, physicalVolumeLockKey } from "@lando/sdk/services";
import { Clock, Context, Effect } from "effect";

import { resolveOperationLockTimeoutMs } from "./lock.ts";

export type VolumeLockMode = "exclusive" | "shared";

/** One physical-volume hold this fiber already owns. */
export type HeldVolumeLock = {
  readonly mode: VolumeLockMode;
  readonly name: string;
};

/**
 * Coordination keys whose advisory lock this fiber already holds, with the mode
 * and native name acquired. Only the lock functions below provide it; forked children
 * inherit it, so work started under a lock stays reentrant. Shared is satisfied by any
 * held mode; exclusive on a shared-held key is a defect (no upgrades).
 */
export const heldVolumeLocks: Context.Reference<ReadonlyMap<string, HeldVolumeLock>> = Context.Reference<
  ReadonlyMap<string, HeldVolumeLock>
>("@lando/state-store/HeldVolumeLocks", {
  defaultValue: (): ReadonlyMap<string, HeldVolumeLock> => new Map(),
});

/**
 * Request a physical-volume advisory lock. `key` is the coordination identity;
 * `name` is the native volume name used for tier classification and wait notices.
 * Callers always supply a request object (never a bare string).
 */
export type VolumeLockRequest = {
  readonly key: string;
  readonly name: string;
  readonly mode?: VolumeLockMode;
  readonly resource?: string;
};

type LockingStateStore = Pick<StateStoreShape, "withLock">;

const modeOf = (request: VolumeLockRequest): VolumeLockMode => request.mode ?? "exclusive";

const resourceOf = (request: VolumeLockRequest): string =>
  (request.resource ?? `volume ${request.name}`).slice(0, 512);

const tierOf = (request: Pick<VolumeLockRequest, "name">): number => physicalVolumeLockTier(request.name);

/** Sort key: tier ascending, then coordination key. */
const compareRequests = (left: VolumeLockRequest, right: VolumeLockRequest): number => {
  const tierDelta = tierOf(left) - tierOf(right);
  if (tierDelta !== 0) return tierDelta;
  return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
};

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
  return [...strongest.values()].sort(compareRequests);
};

/** A held exclusive or shared lock satisfies a shared request; exclusive needs exclusive. */
export const holdsVolumeLock = (
  held: ReadonlyMap<string, HeldVolumeLock>,
  request: VolumeLockRequest,
): boolean => {
  const current = held.get(request.key);
  if (current === undefined) return false;
  return modeOf(request) === "shared" || current.mode === "exclusive";
};

const upgradeDefect = (key: string): Error =>
  new Error(
    `Volume lock upgrade refused: ${key} is held shared and an exclusive request cannot upgrade it. Acquire exclusive for every writer before shared readers nest under the same fiber; this is a Lando bug.`,
  );

/**
 * A nested expansion may only add keys above every key this fiber already holds
 * in canonical (tier, key) order. Multi-key phases acquire their complete union up
 * front, so a lower (tier, key) proves a new nesting site would invert the global
 * lock order.
 */
const assertNestedLockOrder = (
  missing: ReadonlyArray<VolumeLockRequest>,
  held: ReadonlyMap<string, HeldVolumeLock>,
): Effect.Effect<void> => {
  const firstMissing = missing[0];
  if (firstMissing === undefined || held.size === 0) return Effect.void;
  let highest: VolumeLockRequest | undefined;
  for (const [key, value] of held) {
    const candidate: VolumeLockRequest = { key, name: value.name, mode: "exclusive" };
    if (highest === undefined || compareRequests(highest, candidate) < 0) highest = candidate;
  }
  if (highest === undefined) return Effect.void;
  if (compareRequests(highest, firstMissing) < 0) return Effect.void;
  return Effect.die(
    new Error(
      `Volume lock ordering violated: ${firstMissing.key} (tier ${tierOf(firstMissing)}, name ${firstMissing.name}) is not held and sorts at or below already-held ${highest.key} (tier ${tierOf(highest)}, name ${highest.name}). A lifecycle phase must acquire every volume key it will need in canonical tier then key order before it starts; this is a Lando bug.`,
    ),
  );
};

const withHeld = (
  held: ReadonlyMap<string, HeldVolumeLock>,
  request: VolumeLockRequest,
  mode: VolumeLockMode,
): ReadonlyMap<string, HeldVolumeLock> => {
  const next = new Map(held);
  const current = next.get(request.key);
  // Never weaken an exclusive hold to shared while nested work runs under it.
  next.set(request.key, {
    mode: current?.mode === "exclusive" ? "exclusive" : mode,
    name: current?.name ?? request.name,
  });
  return next;
};

const remainingBudgetMs = (deadlineNanos: bigint, nowNanos: bigint): number => {
  const remaining = Number(deadlineNanos - nowNanos) / 1_000_000;
  return Math.max(0, Math.floor(remaining));
};

export const physicalVolumeLockDeadline = Clock.monotonicTimeNanos.pipe(
  Effect.map((now) => {
    const timeoutMs = resolveOperationLockTimeoutMs();
    return { expiresAt: now + BigInt(timeoutMs) * 1_000_000n, timeoutMs };
  }),
);

/**
 * Take the physical-volume advisory lock for this coordination key, or enter
 * directly when this fiber already holds a compatible mode. The advisory lock
 * itself is not reentrant across fibers.
 */
export const withPhysicalVolumeLock = <A, E, R>(
  stateStore: LockingStateStore,
  request: VolumeLockRequest,
  body: Effect.Effect<A, E, R>,
  options: Pick<StateLockOptions, "timeoutMs"> = {},
): Effect.Effect<A, E | StateStoreError, R> => {
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
      return assertNestedLockOrder([request], held).pipe(
        Effect.andThen(
          stateStore.withLock(
            physicalVolumeLockKey(request.key),
            Effect.provideService(body, heldVolumeLocks, withHeld(held, request, mode)),
            lockOptions,
          ),
        ),
      );
    }),
  );
};

/**
 * Acquire several coordination keys in canonical (tier, key) order under one
 * operation-length deadline, skipping keys this fiber already holds in a compatible
 * mode. Nested expansions that would invert lock order die; exclusive requests on a
 * shared-held key die (no upgrades).
 */
export const withPhysicalVolumeLocks = Effect.fnUntraced(function* <A, E, R>(
  stateStore: LockingStateStore,
  requestsInput: ReadonlyArray<VolumeLockRequest>,
  body: Effect.Effect<A, E, R>,
  deadline?: Effect.Success<typeof physicalVolumeLockDeadline>,
): Effect.fn.Return<A, E | StateStoreError, R> {
  const held = yield* heldVolumeLocks;
  const requests = dedupeRequests(requestsInput);
  for (const request of requests) {
    if (held.has(request.key) && !holdsVolumeLock(held, request)) {
      return yield* Effect.die(upgradeDefect(request.key));
    }
  }
  const missing = requests.filter((request) => !holdsVolumeLock(held, request));
  yield* assertNestedLockOrder(missing, held);
  const { expiresAt } = deadline ?? (yield* physicalVolumeLockDeadline);
  const lockAll = (index: number): Effect.Effect<A, E | StateStoreError, R> => {
    const request = missing[index];
    if (request === undefined) return body;
    return Clock.monotonicTimeNanos.pipe(
      Effect.flatMap((now) =>
        withPhysicalVolumeLock(stateStore, request, lockAll(index + 1), {
          timeoutMs: remainingBudgetMs(expiresAt, now),
        }),
      ),
    );
  };
  return yield* lockAll(0);
});
