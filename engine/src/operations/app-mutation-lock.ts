import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { realpath } from "node:fs/promises";

import { DateTime, Effect, FiberRef } from "effect";

import { AppLockTimeoutError, StateStoreError } from "@lando/sdk/errors";
import { MessageWarnEvent } from "@lando/sdk/events";
import { AbsolutePath } from "@lando/sdk/schema";
import { EventService, PathsService } from "@lando/sdk/services";
import { acquireAdvisoryLockAt, peekAdvisoryLockRecord } from "@lando/state-store/lock";
import { resolveStatePath } from "@lando/state-store/paths";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";

/**
 * Finite wait for another process that holds this app's mutate lock.
 * Override with {@link APP_LOCK_TIMEOUT_ENV} (milliseconds). Fail-immediately
 * is worse UX; unbounded wait is worse for CI.
 */
export const DEFAULT_APP_LOCK_TIMEOUT_MS = 120_000;
export const APP_LOCK_TIMEOUT_ENV = "LANDO_APP_LOCK_TIMEOUT_MS";
export const APP_LOCK_HOLDERS_ENV = "LANDO_APP_LOCK_HOLDERS";
export const APP_LOCK_WAIT_MESSAGE = "another Lando command holds the app lock";

const heldAppLockKeys = FiberRef.unsafeMake<ReadonlySet<string>>(new Set());

export const resolveAppLockTimeoutMs = (env: NodeJS.ProcessEnv = process.env): number => {
  const raw = env[APP_LOCK_TIMEOUT_ENV];
  if (raw === undefined || raw === "") return DEFAULT_APP_LOCK_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_APP_LOCK_TIMEOUT_MS;
  return Math.floor(parsed);
};

/**
 * Stable operation-locks key: app id plus the canonical (realpath) root at
 * acquire time. If the app directory is moved or its realpath changes mid-flight,
 * a second command against the new path computes a different key and does not
 * wait on the first lock.
 */
export const appMutationLockKey = (appId: string, canonicalRoot: string): string =>
  `app-${createHash("sha256").update(`${appId}\0${canonicalRoot}`).digest("hex")}`;

export const canonicalAppRoot = (root: string): Effect.Effect<string> =>
  Effect.promise(() => realpath(root).catch(() => root));

const parseHolderEntries = (raw: string | undefined): ReadonlyArray<readonly [string, string]> => {
  if (raw === undefined || raw === "") return [];
  return raw.split(",").flatMap((entry) => {
    const separator = entry.indexOf(":");
    if (separator <= 0) return [];
    const key = entry.slice(0, separator);
    const token = entry.slice(separator + 1);
    return key === "" || token === "" ? [] : ([[key, token]] as const);
  });
};

const serializeHolderEntries = (entries: ReadonlyArray<readonly [string, string]>): string =>
  entries.map(([key, token]) => `${key}:${token}`).join(",");

const installHolderEnv = (key: string, token: string): (() => void) => {
  const previous = process.env[APP_LOCK_HOLDERS_ENV];
  const next = serializeHolderEntries([
    ...parseHolderEntries(previous).filter(([held]) => held !== key),
    [key, token],
  ]);
  process.env[APP_LOCK_HOLDERS_ENV] = next;
  return () => {
    if (previous === undefined) delete process.env[APP_LOCK_HOLDERS_ENV];
    else process.env[APP_LOCK_HOLDERS_ENV] = previous;
  };
};

const parentPidOf = (pid: number): number | undefined => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    if (close === -1) return undefined;
    const ppid = Number(stat.slice(close + 2).split(" ")[1]);
    return Number.isInteger(ppid) && ppid > 0 ? ppid : undefined;
  } catch {
    return undefined;
  }
};

export const isSelfOrAncestorPid = (holderPid: number, pid = process.pid, ppid = process.ppid): boolean => {
  if (holderPid === pid) return true;
  let current = ppid;
  const seen = new Set<number>([pid]);
  while (current > 1 && !seen.has(current)) {
    if (current === holderPid) return true;
    seen.add(current);
    const parent = parentPidOf(current);
    if (parent === undefined) break;
    current = parent;
  }
  return false;
};

/** Child of the lock holder, not another fiber in the same process. */
export const isAncestorPid = (holderPid: number, pid = process.pid, ppid = process.ppid): boolean =>
  holderPid !== pid && isSelfOrAncestorPid(holderPid, pid, ppid);

const isSameHolder = (key: string, lockPath: string): Effect.Effect<boolean> =>
  Effect.promise(async () => {
    const record = await peekAdvisoryLockRecord(lockPath);
    if (record === null) return false;
    // Same PID is another fiber in this process: wait on the file lock.
    // Nested same-process acquires are FiberRef no-ops before this check.
    if (record.pid === process.pid) return false;
    if (isAncestorPid(record.pid)) return true;
    return parseHolderEntries(process.env[APP_LOCK_HOLDERS_ENV]).some(
      ([held, token]) => held === key && token === record.token,
    );
  });

const announceWait = (): Effect.Effect<void> =>
  Effect.gen(function* () {
    const events = yield* Effect.serviceOption(EventService);
    if (events._tag === "None") return;
    yield* events.value.publish(
      MessageWarnEvent.make({
        body: APP_LOCK_WAIT_MESSAGE,
        timestamp: DateTime.unsafeMake(new Date().toISOString()),
      }),
    );
  }).pipe(Effect.catchAll(() => Effect.void));

const timeoutError = (appId: string, timeoutMs: number, cause?: unknown): AppLockTimeoutError =>
  new AppLockTimeoutError({
    message: APP_LOCK_WAIT_MESSAGE,
    app: appId,
    timeoutMs,
    remediation: `Wait for the other command to finish, then retry. Set ${APP_LOCK_TIMEOUT_ENV} (milliseconds) to wait longer.`,
    ...(cause === undefined ? {} : { cause }),
  });

export const appLockTarget = (app: {
  readonly id: unknown;
  readonly root: unknown;
  readonly identity?: { readonly appRoot?: unknown } | undefined;
}): { readonly id: string; readonly root: string } => ({
  id: String(app.id),
  root: String(app.identity?.appRoot ?? app.root),
});

export const appMutationLockIdentity = (app: { readonly id: string; readonly root: string }): Effect.Effect<{
  readonly key: string;
  readonly canonicalRoot: string;
}> =>
  canonicalAppRoot(app.root).pipe(
    Effect.map((canonicalRoot) => ({
      canonicalRoot,
      key: appMutationLockKey(String(app.id), canonicalRoot),
    })),
  );

/**
 * Acquire one per-app advisory file lock around a mutating operation.
 *
 * Reentrancy: already holding this key (in-process FiberRef, inherited
 * {@link APP_LOCK_HOLDERS_ENV} token, or lock-holder PID in this process tree)
 * is a no-op acquire so a plugin/hook/helper that shells out to another `lando`
 * mutate on the same app cannot deadlock.
 *
 * Confirmation prompts belong outside this wrapper. The lock is the mutate
 * phase only.
 */
export const withAppMutationLock = <A, E, R>(
  app: { readonly id: string; readonly root: string },
  body: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | AppLockTimeoutError | StateStoreError, R | PathsService | PrivateFileAccessService> =>
  Effect.gen(function* () {
    const context = yield* Effect.context<R | PathsService | PrivateFileAccessService>();
    const paths = yield* PathsService;
    const privateFileAccess = yield* PrivateFileAccessService;
    const { key } = yield* appMutationLockIdentity(app);
    const held = yield* FiberRef.get(heldAppLockKeys);
    const provided = Effect.provide(body, context).pipe(
      Effect.locally(heldAppLockKeys, new Set([...held, key])),
    );
    if (held.has(key)) return yield* provided;

    const resolved = yield* resolveStatePath(
      { path: AbsolutePath.make(paths.roots.userDataRoot) },
      "operation-locks",
      key,
      "app-mutate",
    );
    const lockPath = `${resolved.file}.lock`;
    if (yield* isSameHolder(key, lockPath)) return yield* provided;

    const timeoutMs = resolveAppLockTimeoutMs();
    return yield* Effect.acquireUseRelease(
      acquireAdvisoryLockAt(lockPath, "app-mutate", {
        expireLiveOwner: false,
        timeoutMs,
        onWait: announceWait(),
        privateFileAccess,
      }).pipe(
        Effect.map((lock) => ({ lock, restore: installHolderEnv(key, lock.token) })),
        Effect.mapError((cause) =>
          cause instanceof StateStoreError && cause.reason === "lock"
            ? timeoutError(String(app.id), timeoutMs, cause)
            : cause,
        ),
      ),
      () => provided,
      ({ lock, restore }) => Effect.sync(restore).pipe(Effect.zipRight(lock.release)),
    );
  });

/** Sync helper for child-process tests that need the same key the parent used. */
export const canonicalAppRootSync = (root: string): string => {
  try {
    return realpathSync(root);
  } catch {
    return root;
  }
};
