import { lstat, mkdir, open, readFile, realpath, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import { Effect, Option, Schema } from "effect";

import { StateStoreError } from "@lando/sdk/errors";

const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 10;
const LOCK_ATTEMPTS = 200;

// The file lock serializes processes, while this guard closes the release-unlink
// race between fibers in the same process.
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

const LockRecord = Schema.Struct({
  pid: Schema.Number.pipe(Schema.int(), Schema.between(1, 2_147_483_647)),
  token: Schema.NonEmptyString.pipe(Schema.maxLength(256)),
  createdAt: Schema.Number.pipe(Schema.int(), Schema.between(0, Number.MAX_SAFE_INTEGER)),
});
type LockRecord = typeof LockRecord.Type;
const parseLockRecord = Schema.decodeUnknownOption(Schema.parseJson(LockRecord), {
  onExcessProperty: "error",
});
const hasCode = (cause: unknown, code: string): boolean =>
  cause instanceof Error && "code" in cause && cause.code === code;

const processIsDead = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (cause) {
    return hasCode(cause, "ESRCH");
  }
};

const readLockRecord = async (lockPath: string): Promise<LockRecord | null> => {
  try {
    return Option.getOrNull(parseLockRecord(await readFile(lockPath, "utf8")));
  } catch (cause) {
    if (hasCode(cause, "ENOENT")) return null;
    throw cause;
  }
};

const lockIdentity = async (lockPath: string) => {
  try {
    return await lstat(lockPath);
  } catch (cause) {
    if (hasCode(cause, "ENOENT")) return null;
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
  `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

const acquire = (
  lockPath: string,
  token: string,
  options: { readonly operation: string; readonly expireLiveOwner?: boolean },
): Effect.Effect<void, StateStoreError> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
      const acquired = yield* Effect.tryPromise({
        try: async () => {
          try {
            await mkdir(dirname(lockPath), { recursive: true });
            const handle = await open(lockPath, "wx", 0o600);
            try {
              const identity = await handle.stat();
              try {
                await handle.chmod(0o600);
                await handle.writeFile(JSON.stringify({ token, pid: process.pid, createdAt: Date.now() }));
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
            if (!hasCode(cause, "EEXIST")) throw cause;
            const identity = await lockIdentity(lockPath);
            if (identity === null) return false;
            if (
              !identity.isFile() ||
              identity.isSymbolicLink() ||
              identity.nlink !== 1 ||
              (process.getuid !== undefined && identity.uid !== process.getuid())
            )
              return false;
            const staleByMtime = Date.now() - identity.mtimeMs > LOCK_STALE_MS;
            const current = await readLockRecord(lockPath).catch((error: unknown) => {
              // A crashed exclusive create can leave owner-owned mode-000 bytes unreadable.
              if (hasCode(error, "EACCES")) return null;
              throw error;
            });
            const takeover =
              current === null
                ? staleByMtime
                : (options.expireLiveOwner !== false && Date.now() - current.createdAt > LOCK_STALE_MS) ||
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
                  if (!hasCode(error, "ENOENT")) throw error;
                });
              }
            }
            return false;
          }
        },
        catch: (cause) => lockError(options.operation, lockPath, cause),
      });
      if (acquired) return;
      yield* Effect.sleep(`${LOCK_RETRY_MS} millis`);
    }
    return yield* Effect.fail(lockError(options.operation, lockPath));
  });

const release = (lockPath: string, token: string): Effect.Effect<void, never> =>
  Effect.promise(async () => {
    const current = await readLockRecord(lockPath);
    if (current?.token === token) {
      await unlink(lockPath).catch((cause: unknown) => {
        if (!hasCode(cause, "ENOENT")) throw cause;
      });
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
  options: { readonly expireLiveOwner?: boolean } = {},
): Effect.Effect<{ readonly token: string; readonly release: Effect.Effect<void> }, StateStoreError> => {
  const token = makeLockToken();
  return acquire(lockPath, token, { operation, ...options }).pipe(
    Effect.as({ token, release: release(lockPath, token) }),
  );
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
        acquire(lockPath, token, { operation }),
        () => body,
        () => release(lockPath, token),
      );
      return guardFor(canonicalFile).pipe(Effect.flatMap((guard) => guard.withPermits(1)(fileLocked)));
    }),
  );

export const LOCK_STALE_THRESHOLD_MS = LOCK_STALE_MS;
