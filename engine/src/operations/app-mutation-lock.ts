import { readFileSync, realpathSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { sha256Hex } from "@lando/sdk/digest";

import { Context, DateTime, Effect } from "effect";

import { AppLockTimeoutError, StateStoreError, isErrnoCode } from "@lando/sdk/errors";
import { MessageWarnEvent } from "@lando/sdk/events";
import { AbsolutePath } from "@lando/sdk/schema";
import { EventService, PathsService } from "@lando/sdk/services";
import { acquireAdvisoryLockAt, peekAdvisoryLockRecord } from "@lando/state-store/lock";
import { resolveStatePath } from "@lando/state-store/paths";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { PinnedAppRoot } from "./app-root-identity.ts";

export { canonicalAppRoot } from "./app-root-identity.ts";

/**
 * Finite wait for another process that holds this app's mutate lock.
 * Override with {@link APP_LOCK_TIMEOUT_ENV} (milliseconds). Fail-immediately
 * is worse UX; unbounded wait is worse for CI.
 */
export const DEFAULT_APP_LOCK_TIMEOUT_MS = 120_000;
export const APP_LOCK_TIMEOUT_ENV = "LANDO_APP_LOCK_TIMEOUT_MS";
export const APP_LOCK_HOLDERS_ENV = "LANDO_APP_LOCK_HOLDERS";
export const APP_LOCK_WAIT_MESSAGE = "another Lando command holds the app lock";

const HeldAppLockKeys = Context.Reference<ReadonlySet<string>>("@lando/engine/HeldAppLockKeys", {
  defaultValue: (): ReadonlySet<string> => new Set(),
});

const HeldGlobalAppRoot = Context.Reference<string | undefined>("@lando/engine/HeldGlobalAppRoot", {
  defaultValue: () => undefined,
});

/** Used by the global coordinator to reject actual-root to policy lock-order upgrades. */
export const heldGlobalAppMutationRoot = HeldGlobalAppRoot;

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
  `app-${sha256Hex(`${appId}\0${canonicalRoot}`)}`;

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

const borrowedMutationOwner = (
  key: string,
  lockPath: string,
): Effect.Effect<number | undefined, StateStoreError> =>
  Effect.tryPromise({
    try: async () => {
      const record = await peekAdvisoryLockRecord(lockPath);
      if (record === null) return undefined;
      // Same PID is another fiber in this process: wait on the file lock.
      // Nested same-process acquires are context-reference no-ops before this check.
      if (record.pid === process.pid) return undefined;
      try {
        process.kill(record.pid, 0);
      } catch (cause) {
        if (isErrnoCode(cause, "ESRCH")) return undefined;
      }
      return isAncestorPid(record.pid) ||
        parseHolderEntries(process.env[APP_LOCK_HOLDERS_ENV]).some(
          ([held, token]) => held === key && token === record.token,
        )
        ? record.pid
        : undefined;
    },
    catch: (cause) =>
      new StateStoreError({
        reason: "io",
        operation: "readAppMutationOwner",
        path: lockPath,
        cause,
        remediation: "Restore access to the app mutation lock and retry.",
      }),
  });

const announceWait = Effect.fnUntraced(
  function* () {
    const events = yield* Effect.serviceOption(EventService);
    if (events._tag === "None") return;
    yield* events.value.publish(
      MessageWarnEvent.make({
        body: APP_LOCK_WAIT_MESSAGE,
        timestamp: DateTime.nowUnsafe(),
      }),
    );
  },
  Effect.catch(() => Effect.void),
);

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

/** Resolve a missing app root through its nearest existing parent for the lock key. */
export const canonicalMissingAppRoot = (root: string): Effect.Effect<string, StateStoreError> =>
  Effect.tryPromise({
    try: async () => {
      const absolute = resolve(root);
      let current = absolute;
      while (true) {
        try {
          const canonicalParent = await realpath(current);
          const suffix = relative(current, absolute);
          return suffix === "" ? canonicalParent : resolve(canonicalParent, suffix);
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
          // A dangling symlink is not a missing directory. Its destination is unknown.
          const stat = await lstat(current).catch((statCause: unknown) => {
            if ((statCause as NodeJS.ErrnoException).code !== "ENOENT") throw statCause;
            return undefined;
          });
          if (stat?.isSymbolicLink()) throw cause;
          const parent = dirname(current);
          if (parent === current) throw cause;
          current = parent;
        }
      }
    },
    catch: (cause) =>
      new StateStoreError({
        reason: "path",
        operation: "canonicalMissingAppRoot",
        path: root,
        cause,
        remediation: "Check that the app root and its parent can be resolved, then retry.",
      }),
  });

export const appMutationLockIdentity = (app: {
  readonly id: string;
  readonly root: string;
}): Effect.Effect<
  {
    readonly key: string;
    readonly canonicalRoot: string;
  },
  StateStoreError
> =>
  canonicalMissingAppRoot(app.root).pipe(
    Effect.map((canonicalRoot) => ({
      canonicalRoot,
      key: appMutationLockKey(String(app.id), canonicalRoot),
    })),
  );

/**
 * Acquire one per-app advisory file lock around a mutating operation.
 *
 * Same-process nesting reuses the context-held key. A child command recognized
 * through ancestry or an inherited holder token refuses borrowed ownership;
 * waiting on a live parent would deadlock when that parent awaits its child.
 *
 * Confirmation prompts belong outside this wrapper. The lock is the mutate
 * phase only.
 */
export const withAppMutationLock = Effect.fnUntraced(function* <A, E, R>(
  app: { readonly id: string; readonly root: string },
  body: Effect.Effect<A, E, R>,
  options: { readonly lockRoot?: string } = {},
): Effect.fn.Return<
  A,
  E | AppLockTimeoutError | StateStoreError,
  R | PathsService | PrivateFileAccessService
> {
  const context = yield* Effect.context<R | PathsService | PrivateFileAccessService>();
  const paths = yield* PathsService;
  const privateFileAccess = yield* PrivateFileAccessService;
  const { key, canonicalRoot } = yield* appMutationLockIdentity(app);
  const held = yield* HeldAppLockKeys;
  const heldGlobalRoot = yield* HeldGlobalAppRoot;
  if (app.id === "global" && heldGlobalRoot !== undefined && heldGlobalRoot !== canonicalRoot)
    return yield* Effect.fail(
      new StateStoreError({
        reason: "lock",
        operation: "nestedGlobalAppMutation",
        path: canonicalRoot,
        remediation: "Finish the current global operation before mutating another global app root.",
      }),
    );
  if (app.id === "global" && options.lockRoot !== undefined)
    return yield* Effect.fail(
      new StateStoreError({
        reason: "path",
        operation: "globalMutationLockRoot",
        path: options.lockRoot,
        remediation: "Global app mutation locks must use the canonical runtime root's lock directory.",
      }),
    );
  const provided = body.pipe(
    Effect.provideService(PinnedAppRoot, { requestedRoot: app.root, canonicalRoot }),
    Effect.provideService(HeldAppLockKeys, new Set([...held, key])),
    Effect.provideService(HeldGlobalAppRoot, app.id === "global" ? canonicalRoot : heldGlobalRoot),
    Effect.provide(context),
  );
  if (held.has(key)) return yield* provided;

  // Embedded hosts can share a physical global root while using different data roots.
  // A per-root namespace also avoids a shared directory owned by another user in /tmp.
  const resolved = yield* resolveStatePath(
    {
      path: AbsolutePath.make(
        app.id === "global" ? dirname(canonicalRoot) : (options.lockRoot ?? paths.roots.userDataRoot),
      ),
    },
    app.id === "global" ? `.lando-global-${key}` : "operation-locks",
    key,
    "app-mutate",
  );
  const lockPath = `${resolved.file}.lock`;
  const borrowed = yield* borrowedMutationOwner(key, lockPath);
  if (borrowed !== undefined)
    return yield* Effect.fail(
      new StateStoreError({
        reason: "lock",
        operation: "nestedAppMutation",
        path: lockPath,
        cause: { app: String(app.id), ownerPid: borrowed },
        remediation:
          "This child command cannot borrow its parent command's app mutation lock. Run nested mutations in the parent process, or run this command after the parent finishes.",
      }),
    );

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
    () =>
      appMutationLockIdentity(app).pipe(
        Effect.flatMap(
          (current): Effect.Effect<A, E | StateStoreError, never> =>
            current.key === key
              ? provided
              : Effect.fail(
                  new StateStoreError({
                    reason: "path",
                    operation: "canonicalMissingAppRoot",
                    path: app.root,
                    remediation: "The app root parent changed while waiting for its lock; retry.",
                  }),
                ),
        ),
      ),
    ({ lock, restore }) => Effect.sync(restore).pipe(Effect.andThen(lock.release)),
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
