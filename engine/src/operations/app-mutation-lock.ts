import { realpathSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import { mapFailures } from "@lando/sdk/command-result";
import { sha256Hex } from "@lando/sdk/digest";
import { AppLockTimeoutError, StateStoreError } from "@lando/sdk/errors";
import { formatWaitDuration } from "@lando/sdk/renderer";
import { AbsolutePath, type AppRef } from "@lando/sdk/schema";
import { PathsService } from "@lando/sdk/services";
import {
  ADVISORY_LOCK_SUFFIX,
  LockHolder,
  acquireAdvisoryLockAt,
  resolveOperationLockTimeoutMs,
} from "@lando/state-store/lock";
import { resolveStatePath } from "@lando/state-store/paths";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { Context, Effect } from "effect";
import { SCRATCH_EXTENSION_KEY } from "../scratch-app/identity.ts";
import { installHolderEnv, isBorrowedOwner } from "./app-lock-borrow.ts";

export { APP_LOCK_HOLDERS_ENV } from "./app-lock-borrow.ts";

import { PinnedAppRoot } from "./app-root-identity.ts";

export { canonicalAppRoot } from "./app-root-identity.ts";

export const HeldAppLockKeys = Context.Reference<ReadonlySet<string>>("@lando/engine/HeldAppLockKeys", {
  defaultValue: (): ReadonlySet<string> => new Set(),
});

const HeldGlobalAppRoot = Context.Reference<string | undefined>("@lando/engine/HeldGlobalAppRoot", {
  defaultValue: () => undefined,
});

/** Used by the global coordinator to reject actual-root to policy lock-order upgrades. */
export const heldGlobalAppMutationRoot = HeldGlobalAppRoot;

/**
 * Stable operation-locks key: user app roots survive renames; scratch and global
 * identities retain their id plus the canonical (realpath) root at
 * acquire time. If the app directory is moved or its realpath changes mid-flight,
 * a second command against the new path computes a different key and does not
 * wait on the first lock.
 */
export const appMutationLockKey = (
  appId: string,
  canonicalRoot: string,
  kind: AppRef["kind"] = appId === "global" || appId === "global-policy" ? "global" : "user",
): string => `app-${sha256Hex(kind === "user" ? canonicalRoot : `${appId}\0${canonicalRoot}`)}`;

const timeoutError = (appId: string, timeoutMs: number, cause: StateStoreError): AppLockTimeoutError =>
  new AppLockTimeoutError({
    message: cause.message ?? `Gave up after ${formatWaitDuration(timeoutMs)} waiting for app ${appId}.`,
    app: appId,
    timeoutMs,
    remediation: cause.remediation,
    cause,
  });

const mapAppLockFailure = (
  appId: string,
  lockPath: string,
  timeoutMs: number,
  cause: StateStoreError,
): StateStoreError | AppLockTimeoutError => {
  if (cause.lockFailure === "timeout") return timeoutError(appId, cause.timeoutMs ?? timeoutMs, cause);
  if (cause.lockFailure === "refused")
    return new StateStoreError({
      reason: "lock",
      lockFailure: "refused",
      operation: "nestedAppMutation",
      message: cause.message,
      path: lockPath,
      ...(cause.ownerPid === undefined ? {} : { ownerPid: cause.ownerPid }),
      ...(cause.resource === undefined ? {} : { resource: cause.resource }),
      cause: { app: appId, ownerPid: cause.ownerPid },
      remediation:
        "This child command cannot borrow its parent command's app mutation lock. Run nested mutations in the parent process, or run this command after the parent finishes.",
    });
  return cause;
};

export const appLockTarget = (app: {
  readonly id: unknown;
  readonly name?: unknown;
  readonly root: unknown;
  readonly identity?: { readonly appRoot?: unknown } | undefined;
  readonly kind?: AppRef["kind"];
  readonly extensions?: Readonly<Record<string, unknown>>;
}): AppLockSubject & { readonly kind: AppRef["kind"] } => ({
  id: String(app.id),
  ...(typeof app.name === "string" ? { name: app.name } : {}),
  root: String(app.identity?.appRoot ?? app.root),
  kind:
    app.kind ??
    (app.extensions !== undefined && Object.hasOwn(app.extensions, SCRATCH_EXTENSION_KEY)
      ? "scratch"
      : app.id === "global"
        ? "global"
        : "user"),
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
  readonly kind?: AppRef["kind"];
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
      key: appMutationLockKey(String(app.id), canonicalRoot, app.kind),
    })),
  );

/** The app a mutation lock serializes; `name` labels wait notices and defaults to the folder name. */
export interface AppLockSubject {
  readonly id: string;
  readonly root: string;
  readonly kind?: AppRef["kind"];
  readonly name?: string;
}

const isGlobalLock = (app: AppLockSubject): boolean =>
  app.kind === "global" || app.id === "global" || app.id === "global-policy";

/**
 * Acquire one per-app advisory file lock around a mutating operation.
 *
 * Same-process nesting reuses the context-held key. A child command recognized
 * through ancestry or an inherited holder token refuses borrowed ownership only
 * when the kernel lock is contended; an uncontended child acquires normally.
 *
 * Confirmation prompts belong outside this wrapper. The lock is the mutate
 * phase only.
 */
export const withAppMutationLock = Effect.fnUntraced(function* <A, E, R>(
  app: AppLockSubject,
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
  // Global services are shared, so their lock keeps the label of the app that needed them.
  const outerHolder = yield* LockHolder;
  const name = app.name ?? (app.kind === "scratch" ? String(app.id) : basename(canonicalRoot));
  const holder = isGlobalLock(app) ? outerHolder : { ...outerHolder, app: name };
  const provided = body.pipe(
    Effect.provideService(LockHolder, holder),
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
  const lockPath = `${resolved.file}${ADVISORY_LOCK_SUFFIX}`;
  const appId = String(app.id);
  const timeoutMs = resolveOperationLockTimeoutMs();
  const resource = isGlobalLock(app) ? "Lando's global services" : `app ${name}`;

  return yield* Effect.scoped(
    Effect.gen(function* () {
      const lock = yield* acquireAdvisoryLockAt(lockPath, "app-mutate", {
        privateFileAccess,
        wait: "operation",
        timeoutMs,
        resource,
        appLock: !isGlobalLock(app),
        refuseOnContention: (record) => Effect.sync(() => isBorrowedOwner(key, record)),
      }).pipe(
        Effect.provideService(LockHolder, holder),
        mapFailures((cause) => mapAppLockFailure(appId, lockPath, timeoutMs, cause)),
      );

      // Install/restore the holder env under acquireRelease so interrupt cannot
      // leave a half-written process.env entry or skip cleanup.
      yield* Effect.acquireRelease(
        Effect.sync(() => installHolderEnv(key, lock.token)),
        (restore) => Effect.sync(restore),
      );

      return yield* appMutationLockIdentity(app).pipe(
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
      );
    }),
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
