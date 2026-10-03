import { lstat, mkdir, open, readFile, realpath, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { Semaphore } from "effect";

import { Clock, DateTime, Effect, Option, Schema } from "effect";

import { StateStoreError, isErrnoCode } from "@lando/sdk/errors";
import type { PrivateFileAccess } from "./private-file-access.ts";

const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 10;
const LOCK_ATTEMPTS = 200;

// The file lock serializes processes, while this guard closes the release-unlink
// race between fibers in the same process.
const inProcessGuards = new Map<string, Semaphore.Semaphore>();

const canonicalLockTarget = (file: string): Effect.Effect<string> =>
  Effect.promise(() => realpath(file).catch(() => file));

const guardFor = (file: string): Effect.Effect<Semaphore.Semaphore> =>
  Effect.sync(() => {
    const existing = inProcessGuards.get(file);
    if (existing !== undefined) return existing;
    const created = Semaphore.makeUnsafe(1);
    inProcessGuards.set(file, created);
    return created;
  });

const LockRecord = Schema.Struct({
  pid: Schema.Number.pipe(
    Schema.check(Schema.isInt()),
    Schema.check(Schema.isBetween({ minimum: 1, maximum: 2_147_483_647 })),
  ),
  token: Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(256))),
  createdAt: Schema.Number.pipe(
    Schema.check(Schema.isInt()),
    Schema.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  ),
});
type LockRecord = typeof LockRecord.Type;
const parseLockRecord = Schema.decodeUnknownOption(Schema.fromJsonString(LockRecord), {
  onExcessProperty: "error",
});
const processIsDead = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (cause) {
    return isErrnoCode(cause, "ESRCH");
  }
};

const readLockRecord = async (lockPath: string): Promise<LockRecord | null> => {
  try {
    return Option.getOrNull(parseLockRecord(await readFile(lockPath, "utf8")));
  } catch (cause) {
    if (isErrnoCode(cause, "ENOENT")) return null;
    throw cause;
  }
};

const lockIdentity = async (lockPath: string) => {
  try {
    return await lstat(lockPath);
  } catch (cause) {
    if (isErrnoCode(cause, "ENOENT")) return null;
    throw cause;
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

export const makeLockToken = (): string =>
  `${process.pid}-${DateTime.toEpochMillis(DateTime.nowUnsafe())}-${Math.random().toString(36).slice(2)}`;

export type AdvisoryLockRecord = LockRecord;

/** Read the owner record at an exact lock path, or `null` when absent/invalid. */
export const peekAdvisoryLockRecord = (lockPath: string): Promise<LockRecord | null> =>
  readLockRecord(lockPath);

export interface AdvisoryLockWaitOptions {
  readonly expireLiveOwner?: boolean;
  /** Overall acquire deadline. Defaults to {@link LOCK_ATTEMPTS} × {@link LOCK_RETRY_MS}. */
  readonly timeoutMs?: number;
  readonly retryMs?: number;
  /** Runs once after the first contended attempt, before further retries. */
  readonly onWait?: Effect.Effect<void>;
}

const acquire = Effect.fn("StateStore.acquireLock")(function* (
  lockPath: string,
  token: string,
  options: {
    readonly operation: string;
    readonly expireLiveOwner?: boolean;
    readonly timeoutMs?: number;
    readonly retryMs?: number;
    readonly onWait?: Effect.Effect<void>;
    readonly privateFileAccess: PrivateFileAccess;
  },
): Effect.fn.Return<void, StateStoreError> {
  const retryMs = options.retryMs ?? LOCK_RETRY_MS;
  const timeoutMs = options.timeoutMs ?? LOCK_ATTEMPTS * LOCK_RETRY_MS;
  const deadline = (yield* Clock.currentTimeMillis) + timeoutMs;
  let announced = false;
  for (;;) {
    const now = yield* Clock.currentTimeMillis;
    const acquired = yield* Effect.tryPromise({
      try: async () => {
        try {
          await mkdir(dirname(lockPath), { recursive: true });
          const handle = await open(lockPath, "wx", 0o600);
          try {
            const identity = await handle.stat();
            try {
              await handle.chmod(0o600);
              await options.privateFileAccess.enforce(lockPath);
              await handle.writeFile(JSON.stringify({ token, pid: process.pid, createdAt: now }));
              await handle.sync();
            } catch (cause) {
              const current = await lockIdentity(lockPath);
              if (
                current?.dev === identity.dev &&
                current.ino === identity.ino &&
                !current.isSymbolicLink()
              ) {
                await unlink(lockPath);
              }
              throw cause;
            }
          } finally {
            await handle.close();
          }
          return true;
        } catch (cause) {
          if (!isErrnoCode(cause, "EEXIST")) throw cause;
          const identity = await lockIdentity(lockPath);
          if (identity === null) return false;
          if (
            !identity.isFile() ||
            identity.isSymbolicLink() ||
            identity.nlink !== 1 ||
            (process.getuid !== undefined && identity.uid !== process.getuid())
          )
            return false;
          await options.privateFileAccess.verify(lockPath);
          const staleByMtime = now - identity.mtimeMs > LOCK_STALE_MS;
          const current = await readLockRecord(lockPath).catch((error: unknown) => {
            // A crashed exclusive create can leave owner-owned mode-000 bytes unreadable.
            if (isErrnoCode(error, "EACCES")) return null;
            throw error;
          });
          const takeover =
            current === null
              ? staleByMtime
              : (options.expireLiveOwner !== false && now - current.createdAt > LOCK_STALE_MS) ||
                processIsDead(current.pid);
          if (takeover) {
            const latest = await lockIdentity(lockPath);
            if (
              latest?.dev === identity.dev &&
              latest.ino === identity.ino &&
              latest.uid === identity.uid &&
              latest.mode === identity.mode &&
              latest.nlink === 1 &&
              latest.mtimeMs === identity.mtimeMs &&
              latest.ctimeMs === identity.ctimeMs
            ) {
              await unlink(lockPath).catch((error: unknown) => {
                if (!isErrnoCode(error, "ENOENT")) throw error;
              });
            }
          }
          return false;
        }
      },
      catch: (cause) => lockError(options.operation, lockPath, cause),
    });
    if (acquired) return;
    if ((yield* Clock.currentTimeMillis) >= deadline)
      return yield* Effect.fail(lockError(options.operation, lockPath));
    if (!announced && options.onWait !== undefined) {
      announced = true;
      yield* options.onWait;
    }
    yield* Effect.sleep(`${retryMs} millis`);
  }
});

const release = (
  lockPath: string,
  token: string,
  privateFileAccess: PrivateFileAccess,
): Effect.Effect<void, never> =>
  Effect.promise(async () => {
    const identity = await lockIdentity(lockPath);
    if (identity === null) return;
    await privateFileAccess.verify(lockPath);
    const current = await readLockRecord(lockPath);
    if (current?.token === token) {
      await unlink(lockPath).catch((cause: unknown) => {
        if (!isErrnoCode(cause, "ENOENT")) throw cause;
      });
    }
  });

/**
 * Acquire an advisory lock at an EXACT lock path (no derived `${file}.lock`
 * suffix) and return its token plus a token-checked release effect. Reuses the
 * same stale-takeover semantics as {@link withAdvisoryLockUsing} so a dead or expired
 * holder is reclaimed. Callers that need scope-managed acquire/use/release
 * should prefer {@link withAdvisoryLockUsing}; this lower-level handle exists for
 * surfaces that hold the lock outside an `acquireUseRelease` bracket.
 */
export const acquireAdvisoryLockAt = (
  lockPath: string,
  operation: string,
  options: {
    readonly expireLiveOwner?: boolean;
    readonly timeoutMs?: number;
    readonly retryMs?: number;
    readonly onWait?: Effect.Effect<void>;
    readonly privateFileAccess: PrivateFileAccess;
  },
): Effect.Effect<{ readonly token: string; readonly release: Effect.Effect<void> }, StateStoreError> => {
  const token = makeLockToken();
  return acquire(lockPath, token, { operation, ...options }).pipe(
    Effect.as({
      token,
      release: release(lockPath, token, options.privateFileAccess),
    }),
  );
};

/**
 * Run `body` while holding the advisory lock for `file`. The lock is acquired
 * before `body`, registered into the ambient `Scope` for guaranteed
 * token-checked release, and released after `body` settles (success, failure,
 * or interrupt).
 */
export const withAdvisoryLockUsing =
  (privateFileAccess: PrivateFileAccess, options: AdvisoryLockWaitOptions = {}) =>
  <A, E>(
    file: string,
    operation: string,
    body: Effect.Effect<A, E>,
    callOptions: AdvisoryLockWaitOptions = {},
  ): Effect.Effect<A, E | StateStoreError> =>
    canonicalLockTarget(file).pipe(
      Effect.flatMap((canonicalFile) => {
        const lockPath = `${canonicalFile}.lock`;
        const token = makeLockToken();
        const fileLocked = Effect.acquireUseRelease(
          acquire(lockPath, token, {
            operation,
            privateFileAccess,
            ...options,
            ...callOptions,
          }),
          () => body,
          () => release(lockPath, token, privateFileAccess),
        );
        return guardFor(canonicalFile).pipe(Effect.flatMap((guard) => guard.withPermits(1)(fileLocked)));
      }),
    );

export const LOCK_STALE_THRESHOLD_MS = LOCK_STALE_MS;
