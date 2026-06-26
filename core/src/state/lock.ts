// A generic cross-process advisory file lock. Acquisition is an
// `O_CREAT|O_EXCL` exclusive create of `<file>.lock` carrying the owner's
// `{ pid, token, createdAt }`. On contention the holder is taken over only when
// it is demonstrably stale: its record is unreadable, older than the age
// threshold, or owned by a dead pid (`process.kill(pid, 0)` throws `ESRCH`).
// Acquisition retries with a bounded backoff. Release is TOKEN-CHECKED — the
// lockfile is removed only when it still carries our token — and is registered
// into the ambient `Scope` via `Effect.acquireUseRelease`, so an interrupted or
// failed critical section always releases the lock and never deletes a lock a
// different owner has since taken.

import { mkdir, open, readFile, realpath, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import { Effect } from "effect";

import { StateStoreError } from "@lando/sdk/errors";

const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 10;
const LOCK_ATTEMPTS = 200;

// The file lock serializes across PROCESSES; a per-path in-process semaphore is
// also required because Effect can interleave two fibers in the window between a
// holder's release-unlink and the next `O_EXCL` create. Both layers are load
// bearing: remove the semaphore and same-process fibers can lose a write.
const inProcessGuards = new Map<string, Effect.Semaphore>();

const canonicalLockTarget = (file: string): Effect.Effect<string> =>
  Effect.promise(() => realpath(file).catch(() => file));

const guardFor = (file: string): Effect.Effect<Effect.Semaphore> =>
  Effect.sync(() => {
    const existing = inProcessGuards.get(file);
    if (existing !== undefined) return existing;
    const created = Effect.unsafeMakeSemaphore(1);
    inProcessGuards.set(file, created);
    return created;
  });

interface LockRecord {
  readonly pid: number;
  readonly token: string;
  readonly createdAt: number;
}

const processIsDead = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (cause) {
    return (cause as { readonly code?: unknown }).code === "ESRCH";
  }
};

const readLockRecord = async (lockPath: string): Promise<LockRecord | null> => {
  try {
    return JSON.parse(await readFile(lockPath, "utf8")) as LockRecord;
  } catch {
    return null;
  }
};

const lockFileIsStaleByMtime = async (lockPath: string): Promise<boolean> => {
  try {
    const stats = await stat(lockPath);
    return Date.now() - stats.mtimeMs > LOCK_STALE_MS;
  } catch {
    return true;
  }
};

const lockError = (operation: string, lockPath: string, cause?: unknown): StateStoreError =>
  new StateStoreError({
    reason: "lock",
    operation,
    path: lockPath,
    ...(cause === undefined ? {} : { cause }),
    remediation: "Another process holds the advisory state lock; retry once it releases.",
  });

/** Mint a process-unique lock token. */
export const makeLockToken = (): string =>
  `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

const acquire = (lockPath: string, token: string, operation: string): Effect.Effect<void, StateStoreError> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
      const acquired = yield* Effect.tryPromise({
        try: async () => {
          try {
            await mkdir(dirname(lockPath), { recursive: true });
            const handle = await open(lockPath, "wx");
            await handle.writeFile(JSON.stringify({ token, pid: process.pid, createdAt: Date.now() }));
            await handle.close();
            return true;
          } catch (cause) {
            if ((cause as { code?: string }).code !== "EEXIST") throw cause;
            // An unparseable record means the holder just `O_EXCL`-created the
            // file but has not flushed its JSON body yet; gate that takeover on
            // the lockfile's own mtime so a live owner mid-flush is never evicted.
            const current = await readLockRecord(lockPath);
            const takeover =
              current === null
                ? await lockFileIsStaleByMtime(lockPath)
                : Date.now() - current.createdAt > LOCK_STALE_MS || processIsDead(current.pid);
            if (takeover) {
              await unlink(lockPath).catch(() => undefined);
            }
            return false;
          }
        },
        catch: (cause) => lockError(operation, lockPath, cause),
      });
      if (acquired) return;
      yield* Effect.sleep(`${LOCK_RETRY_MS} millis`);
    }
    return yield* Effect.fail(lockError(operation, lockPath));
  });

const release = (lockPath: string, token: string): Effect.Effect<void, never> =>
  Effect.promise(async () => {
    const current = await readFile(lockPath, "utf8").catch(() => null);
    if (current === null) return;
    try {
      if ((JSON.parse(current) as { token?: string }).token === token) {
        await unlink(lockPath).catch(() => undefined);
      }
    } catch {
      // Unknown owner: leave it for acquire-time stale-record handling instead
      // of deleting a lock we cannot prove belongs to this holder.
    }
  });

/**
 * Acquire an advisory lock at an EXACT lock path (no derived `${file}.lock`
 * suffix) and return its token plus a token-checked release effect. Reuses the
 * same stale-takeover semantics as {@link withAdvisoryLock} so a dead or expired
 * holder is reclaimed. Callers that need scope-managed acquire/use/release
 * should prefer {@link withAdvisoryLock}; this lower-level handle exists for
 * surfaces that hold the lock outside an `acquireUseRelease` bracket.
 */
export const acquireAdvisoryLockAt = (
  lockPath: string,
  operation: string,
): Effect.Effect<{ readonly token: string; readonly release: Effect.Effect<void> }, StateStoreError> => {
  const token = makeLockToken();
  return acquire(lockPath, token, operation).pipe(Effect.as({ token, release: release(lockPath, token) }));
};

/**
 * Run `body` while holding the advisory lock for `file`. The lock is acquired
 * before `body`, registered into the ambient `Scope` for guaranteed
 * token-checked release, and released after `body` settles (success, failure,
 * or interrupt).
 */
export const withAdvisoryLock = <A, E>(
  file: string,
  operation: string,
  body: Effect.Effect<A, E>,
): Effect.Effect<A, E | StateStoreError> =>
  canonicalLockTarget(file).pipe(
    Effect.flatMap((canonicalFile) => {
      const lockPath = `${canonicalFile}.lock`;
      const token = makeLockToken();
      const fileLocked = Effect.acquireUseRelease(
        acquire(lockPath, token, operation),
        () => body,
        () => release(lockPath, token),
      );
      return guardFor(canonicalFile).pipe(Effect.flatMap((guard) => guard.withPermits(1)(fileLocked)));
    }),
  );

export const LOCK_STALE_THRESHOLD_MS = LOCK_STALE_MS;
