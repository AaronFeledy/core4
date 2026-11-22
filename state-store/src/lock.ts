import { randomUUID } from "node:crypto";
import { ftruncateSync, lstatSync, writeSync } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { StateStoreError, isErrnoCode } from "@lando/sdk/errors";
import type { StateLockOptions } from "@lando/sdk/services";
import { Clock, Deferred, Effect, Exit, Option, Scope } from "effect";
import { enqueueLock } from "./lock-gate.ts";
import { LOCK_HOLDER_LABEL_MAX, LockHolder } from "./lock-holder.ts";
import { type AdvisoryLockRecord, peekAdvisoryLockRecord } from "./lock-record.ts";
import { makeLockReentryGuard } from "./lock-reentry.ts";
import { describeLockHolder, holderDetails, lockWaitBudget, makeLockWait } from "./lock-wait.ts";
import { NativeLockLoader, UnsafeSentinelError, checkSentinel } from "./native-lock.ts";
import type { PrivateFileAccess } from "./private-file-access.ts";

export { LockHolder, type LockHolderContext } from "./lock-holder.ts";
export { type AdvisoryLockRecord, peekAdvisoryLockRecord } from "./lock-record.ts";
export {
  lockTimeout,
  lockWaitBudget,
  resolveOperationLockTimeoutMs,
} from "./lock-wait.ts";

export const ADVISORY_LOCK_SUFFIX = ".lck";
const enter = makeLockReentryGuard();

interface NativeLockOptions extends StateLockOptions {
  readonly privateFileAccess: PrivateFileAccess;
  readonly refuseOnContention?: (record: AdvisoryLockRecord) => Effect.Effect<boolean>;
  /** The lock stands for a whole app, so a waiter waits for its command to finish. */
  readonly appLock?: boolean;
}

type LockLocation = { readonly path: string; readonly kind: "sentinel" | "target" };

const acquire = Effect.fnUntraced(function* (
  location: LockLocation,
  operation: string,
  options: NativeLockOptions,
) {
  const sentinel = location.kind === "sentinel" ? location.path : `${location.path}${ADVISORY_LOCK_SUFFIX}`;
  const resource = (
    options.resource ?? `Lando state file ${basename(location.path, ADVISORY_LOCK_SUFFIX)}`
  ).slice(0, 512);
  const timeoutMs = lockWaitBudget(options);
  const start = yield* Clock.monotonicTimeNanos;
  const deadline = start + BigInt(timeoutMs) * 1_000_000n;
  const mode = options.mode ?? "exclusive";
  const error = (path: string, cause: unknown) => {
    const defect =
      cause instanceof UnsafeSentinelError
        ? cause.message
        : isErrnoCode(cause, "ELOOP")
          ? "a symbolic link or part of a symbolic link loop"
          : undefined;
    return new StateStoreError({
      reason: defect === undefined ? "lock" : "path",
      operation,
      path,
      cause,
      message:
        defect !== undefined
          ? `Unsafe advisory lock path ${path}: ${defect}.`
          : `Could not lock ${resource}.`,
      remediation:
        defect === undefined
          ? "Keep Lando data roots on a local disk and check that the lock directory is private and writable."
          : `Lock path ${path} is ${defect}, so Lando cannot use it. Make sure no Lando command is running, remove ${path}, and retry.`,
    });
  };
  const lockPath = yield* Effect.tryPromise({
    try: async () => {
      if (location.kind === "target") {
        // Resolve the target, never the sentinel itself: symlink sentinels must still be rejected.
        try {
          return `${await realpath(location.path)}${ADVISORY_LOCK_SUFFIX}`;
        } catch (cause) {
          if (!isErrnoCode(cause, "ENOENT")) throw cause;
        }
      }
      const parent = dirname(sentinel);
      await mkdir(parent, { recursive: true });
      return join(await realpath(parent), basename(sentinel));
    },
    catch: (cause) => error(isErrnoCode(cause, "ELOOP") ? dirname(sentinel) : sentinel, cause),
  });
  yield* enter(lockPath);
  const outer = yield* Effect.scope;
  const holder = yield* LockHolder;
  const wait = yield* makeLockWait(
    {
      path: lockPath,
      operation,
      resource,
      timeoutMs,
      wait: options.wait ?? "brief",
      subject: options.appLock === true ? "app" : "resource",
    },
    deadline,
  );
  const pending = yield* enqueueLock(lockPath, mode);
  if (pending !== undefined) {
    while (true) {
      if ((yield* wait.remaining) <= 0) return yield* wait.timeout();
      yield* wait.onContention();
      const delay = yield* wait.untilNextWake;
      if (delay <= 0) continue;
      const granted = yield* Deferred.await(pending).pipe(Effect.timeoutOption(delay));
      if (Option.isSome(granted)) break;
    }
  }

  const load = yield* NativeLockLoader;
  const openNative = yield* Effect.tryPromise({ try: load, catch: (cause) => error(lockPath, cause) });
  if (timeoutMs > 0 && (yield* wait.remaining) <= 0) return yield* wait.timeout();
  const token = randomUUID();
  const attempt = Effect.fnUntraced(function* () {
    const scope = yield* Scope.fork(outer);
    let acquired = false;
    let recordStarted = false;
    let current = false;
    const probe = Effect.gen(function* () {
      const handle = yield* Effect.acquireRelease(
        Effect.try({
          try: () => {
            const named = lstatSync(lockPath, { throwIfNoEntry: false });
            if (named !== undefined) checkSentinel(named);
            try {
              return openNative(lockPath);
            } catch (cause) {
              if (isErrnoCode(cause, "ENOENT")) return undefined;
              throw cause;
            }
          },
          catch: (cause) => error(lockPath, cause),
        }),
        (held) =>
          Effect.sync(() => {
            if (held === undefined) return;
            try {
              if (acquired) {
                try {
                  if (recordStarted) held.withRecord((fd) => ftruncateSync(fd, 0));
                  if (current && mode === "exclusive") held.unlinkIfCurrent?.();
                } finally {
                  held.unlock();
                }
              }
            } finally {
              held.close();
            }
          }),
      );
      if (handle === undefined) return "replaced" as const;
      const enforce = Effect.tryPromise({
        try: () => options.privateFileAccess.enforce(lockPath),
        catch: (cause) => error(lockPath, cause),
      });
      if (handle.created && handle.unlinkIfCurrent === undefined) yield* enforce;
      const createdAt = yield* Clock.currentTimeMillis;
      const result = yield* Effect.try({
        try: () => {
          const outcome = handle.tryLock(mode);
          acquired = outcome === "acquired";
          if (acquired) current = handle.verifyIdentity();
          return outcome;
        },
        catch: (cause) => error(lockPath, cause),
      });
      if (acquired && !current) return "replaced" as const;
      if (handle.created && current && handle.unlinkIfCurrent !== undefined) yield* enforce;
      yield* Effect.tryPromise({
        try: () => options.privateFileAccess.verify(lockPath),
        catch: (cause) => error(lockPath, cause),
      });
      if (acquired && mode === "exclusive")
        yield* Effect.try({
          try: () =>
            handle.withRecord((fd) => {
              recordStarted = true;
              const bytes = Buffer.from(
                JSON.stringify({
                  token,
                  pid: process.pid,
                  createdAt,
                  resource,
                  ...(holder.command === undefined
                    ? {}
                    : { command: holder.command.slice(0, LOCK_HOLDER_LABEL_MAX) }),
                  ...(holder.app === undefined ? {} : { app: holder.app.slice(0, LOCK_HOLDER_LABEL_MAX) }),
                }),
              );
              if (writeSync(fd, bytes, 0, bytes.length, 0) !== bytes.length)
                throw new Error("Short advisory lock record write");
              ftruncateSync(fd, bytes.length);
            }),
          catch: (cause) => error(lockPath, cause),
        });
      return result;
    });
    return yield* probe.pipe(
      Effect.provideService(Scope.Scope, scope),
      Effect.onExit((exit) =>
        Exit.isSuccess(exit) && exit.value === "acquired" ? Effect.void : Scope.close(scope, exit),
      ),
    );
  });

  // Brief holds are millisecond-scale; a 250ms sleep burns 1/8 of their budget.
  // Operation holds can last minutes, so keep their lower steady-state poll rate.
  const maxDelay = options.wait === "operation" ? 250 : 20;
  let delay = 5;
  while (true) {
    const outcome = yield* attempt();
    if (outcome === "acquired") return { token };
    if (outcome === "contended") {
      const record = options.refuseOnContention === undefined ? null : peekAdvisoryLockRecord(lockPath);
      if (
        record !== null &&
        options.refuseOnContention !== undefined &&
        (yield* options.refuseOnContention(record))
      ) {
        const reprobe = yield* attempt();
        if (reprobe === "acquired") return { token };
        if (reprobe === "contended" && peekAdvisoryLockRecord(lockPath)?.token === record.token) {
          const now = yield* Clock.currentTimeMillis;
          return yield* new StateStoreError({
            reason: "lock",
            lockFailure: "refused",
            operation,
            path: lockPath,
            resource,
            ...holderDetails(record, now),
            message: `${resource} is already held by ${describeLockHolder(record, now)}.`,
            remediation: "Run the nested mutation in the parent command or retry after it finishes.",
          });
        }
      }
      yield* wait.onContention();
    }
    const remaining = yield* wait.remaining;
    if (remaining <= 0) return yield* wait.timeout();
    if (outcome === "replaced") {
      yield* Effect.tryPromise({
        try: () => mkdir(dirname(lockPath), { recursive: true }),
        catch: (cause) => error(lockPath, cause),
      });
    }
    yield* Effect.sleep(Math.min(delay, remaining));
    if ((yield* wait.remaining) <= 0) return yield* wait.timeout();
    delay = Math.min(maxDelay, delay * 2);
  }
});

const acquireScoped = Effect.fn("StateStore.acquireLock")(function* (
  location: LockLocation,
  operation: string,
  options: NativeLockOptions,
) {
  // Close immediately on failed acquisition, even if the caller catches it in a long-lived scope.
  // In reverse finalizer order the native handle closes before the local ticket is released.
  const scope = yield* Scope.fork(yield* Effect.scope);
  return yield* acquire(location, operation, options).pipe(
    Effect.provideService(Scope.Scope, scope),
    Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : Scope.close(scope, exit))),
  );
});

/** The returned token is valid until the caller's scope closes. */
export const acquireAdvisoryLockAt = (sentinel: string, operation: string, options: NativeLockOptions) =>
  acquireScoped({ path: sentinel, kind: "sentinel" }, operation, options);

export const withAdvisoryLockUsing =
  (privateFileAccess: PrivateFileAccess, options: StateLockOptions = {}) =>
  <A, E, R>(
    file: string,
    operation: string,
    body: Effect.Effect<A, E, R>,
    callOptions: StateLockOptions = {},
  ) =>
    Effect.scopedWith((scope) =>
      acquireScoped({ path: file, kind: "target" }, operation, {
        ...options,
        ...callOptions,
        privateFileAccess,
      }).pipe(Effect.provideService(Scope.Scope, scope), Effect.andThen(body)),
    );
