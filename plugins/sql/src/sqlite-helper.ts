import { randomUUID } from "node:crypto";
import { chmodSync, chownSync, mkdirSync } from "node:fs";
import { lstat, rm } from "node:fs/promises";
import { join } from "node:path";

import { sqliteHelperImage } from "@lando/container-runtime/data-plane";
import { SqlCommandFailedError, SqlRecoveryUnavailableError } from "@lando/sdk/errors";
import { type AppPlan, planAppIdentity } from "@lando/sdk/schema";
import type { EphemeralRunSpec, ExecResult } from "@lando/sdk/services";
import { Effect, Exit } from "effect";

import { SQLITE_HEADER_BYTES, isSqliteDatabaseHeader } from "./sqlite-header.ts";
import {
  requireSqliteCoveringMount,
  sqliteContainerPath,
  sqliteHelperAccess,
  sqliteHelperUser,
} from "./sqlite-mount.ts";
import { SQLITE_HELPER_SCRATCH_TARGET } from "./sqlite-path.ts";
import type { SqlFileTarget } from "./target.ts";
import type { SqlPlanService } from "./views.ts";

export type SqliteHelperRun = (spec: EphemeralRunSpec) => Effect.Effect<ExecResult, unknown>;
export type SqliteHelperPull = (spec: {
  readonly ref: string;
  readonly policy?: "always" | "missing" | "never";
}) => Effect.Effect<{ readonly digest?: string }, unknown>;

export type SqliteHelperDeps = {
  readonly applied: AppPlan;
  readonly run: SqliteHelperRun;
  readonly pullArtifact: SqliteHelperPull;
  readonly paths: {
    readonly ownerSnapshotsDir: (ownerKey: string) => string;
  };
};

export type SqliteHelperContext = {
  readonly dbPath: string;
  readonly scratchHost: string;
  readonly scratchTarget: string;
  readonly user: string;
  readonly spec: Omit<EphemeralRunSpec, "command" | "stdinStream" | "captureStdout">;
};

const helperFailure = (
  target: SqlFileTarget,
  command: ReadonlyArray<string>,
  result: Pick<ExecResult, "exitCode" | "stderr">,
): SqlCommandFailedError =>
  new SqlCommandFailedError({
    message: `SQLite helper failed for ${target.name}.`,
    service: target.name,
    command,
    exitCode: result.exitCode,
    reason: "exit",
    ...(result.stderr.length === 0 ? {} : { stderrTail: result.stderr.slice(-8192) }),
    remediation: "Inspect the helper stderr, confirm sqlite.path is on a writable mount, then retry.",
  });

export const resolveSqliteHelperImage = (
  deps: SqliteHelperDeps,
): Effect.Effect<string, SqlRecoveryUnavailableError> =>
  deps.pullArtifact({ ref: sqliteHelperImage.ref, policy: "missing" }).pipe(
    Effect.mapError(
      (cause) =>
        new SqlRecoveryUnavailableError({
          message: "Cannot acquire the pinned SQLite helper image.",
          service: "sqlite",
          reason: String(cause),
          remediation:
            "Check network and registry access, then retry. Lando only runs the sqlite3 helper from a pinned digest.",
        }),
    ),
    Effect.flatMap((ref) =>
      ref.digest !== undefined && ref.digest !== sqliteHelperImage.digest
        ? Effect.fail(
            new SqlRecoveryUnavailableError({
              message: "Pinned SQLite helper image digest could not be verified.",
              service: "sqlite",
              reason: "The provider returned a different image digest than the pinned manifest.",
              remediation:
                "Refuse to run an unverified helper image; retry after checking the provider runtime.",
            }),
          )
        : Effect.succeed(sqliteHelperImage.ref),
    ),
  );

const helperOwnerKey = (applied: AppPlan): string =>
  applied.identity?.ownerKey ?? planAppIdentity({ root: applied.root }).ownerKey;

const parseHelperUser = (user: string): { readonly uid: number; readonly gid: number } | undefined => {
  const [uidText, gidText] = user.split(":");
  const uid = Number(uidText);
  const gid = Number(gidText);
  if (!Number.isInteger(uid) || !Number.isInteger(gid) || uid < 0 || gid < 0) return undefined;
  return { uid, gid };
};

const processGroups = (): ReadonlySet<number> => {
  const groups = new Set<number>();
  const gid = process.getgid?.();
  if (typeof gid === "number") groups.add(gid);
  for (const extra of process.getgroups?.() ?? []) groups.add(extra);
  return groups;
};

/**
 * Keep the Lando process as directory owner so Effect.ensuring can still rm.
 * When CAP_CHOWN is missing, share the helper gid (2770 setgid) or fall back
 * to a sticky world-writable directory so the helper can create scratch files.
 */
export const prepareSqliteScratchDir = (path: string, user: string): void => {
  mkdirSync(path, { recursive: true });
  const parsed = parseHelperUser(user);
  if (parsed === undefined) {
    chmodSync(path, 0o1777);
    return;
  }
  try {
    chownSync(path, parsed.uid, parsed.gid);
    return;
  } catch {
    // No CAP_CHOWN: keep Lando as owner so cleanup still works.
  }
  if (processGroups().has(parsed.gid)) {
    try {
      chownSync(path, -1, parsed.gid);
      chmodSync(path, 0o2770);
      return;
    } catch {
      // Fall through to sticky world-writable.
    }
  }
  chmodSync(path, 0o1777);
};

export const sqliteScratchFile = (
  helper: SqliteHelperContext,
  suffix: string,
): { readonly host: string; readonly target: string; readonly name: string } => {
  const name = `${randomUUID()}${suffix}`;
  return { host: join(helper.scratchHost, name), target: `${helper.scratchTarget}/${name}`, name };
};

export const copyHostFile = (from: string, to: string, service: string, message: string) =>
  Effect.tryPromise({
    try: async () => {
      const writer = Bun.file(to).writer();
      for await (const chunk of Bun.file(from).stream()) writer.write(chunk);
      await writer.end();
    },
    catch: (cause) =>
      new SqlRecoveryUnavailableError({
        message,
        service,
        reason: String(cause),
        remediation: "Check permissions on the Lando user data directory, then retry.",
      }),
  });

export const hostFileSize = (path: string): number => {
  const size = Bun.file(path).size;
  return typeof size === "number" && Number.isFinite(size) ? size : 0;
};

export const requireSqliteDatabaseHeader = (
  path: string,
  service: string,
  message: string,
): Effect.Effect<void, SqlRecoveryUnavailableError> =>
  Effect.tryPromise({
    try: async () => {
      const info = await lstat(path);
      if (!info.isFile())
        throw new Error("The SQLite payload must be a regular file, not a symlink or directory.");
      const prefix = new Uint8Array(await Bun.file(path).slice(0, SQLITE_HEADER_BYTES).arrayBuffer());
      if (!isSqliteDatabaseHeader(prefix)) {
        throw new Error("The file does not start with the SQLite format 3 header.");
      }
    },
    catch: (cause) =>
      new SqlRecoveryUnavailableError({
        message,
        service,
        reason: String(cause),
        remediation: "Confirm sqlite.path is a SQLite database on a writable mount, then retry.",
      }),
  });

export const removeSqliteHelperScratch = (
  scratchHost: string,
  service = "sqlite",
): Effect.Effect<void, SqlRecoveryUnavailableError> =>
  Effect.tryPromise({
    try: () => rm(scratchHost, { recursive: true, force: true }).then(() => undefined),
    catch: (cause) =>
      new SqlRecoveryUnavailableError({
        message: `Cannot remove SQLite helper scratch at ${scratchHost}.`,
        service,
        reason: String(cause),
        remediation:
          "Check scratch directory ownership and permissions. Preserve any recovery evidence before removing retained files.",
      }),
  });

export const prepareSqliteHelper = Effect.fn("Sql.prepareSqliteHelper")(function* (
  deps: SqliteHelperDeps,
  service: SqlPlanService,
  target: SqlFileTarget,
) {
  const covering = requireSqliteCoveringMount(service, target);
  if (covering instanceof SqlRecoveryUnavailableError) return yield* Effect.fail(covering);
  const dbPath = sqliteContainerPath(service, target);
  if (dbPath === undefined) {
    return yield* Effect.fail(
      new SqlRecoveryUnavailableError({
        message: `Service ${target.name} has no app mount covering SQLite path ${target.path}.`,
        service: target.name,
        reason: "The SQLite file is relative to the service app mount.",
        remediation: "Set an app mount on the service, then retry.",
      }),
    );
  }
  const image = yield* resolveSqliteHelperImage(deps);
  const inspectionAccess = sqliteHelperAccess({ ...covering, readOnly: true }, deps.applied);
  const inspected = yield* deps
    .run({
      image,
      ...(inspectionAccess.owner === undefined ? {} : { owner: inspectionAccess.owner }),
      ...(inspectionAccess.mounts === undefined ? {} : { mounts: inspectionAccess.mounts }),
      binds: inspectionAccess.binds,
      user: "0:0",
      entrypoint: [],
      remove: true,
      captureStdout: true,
      command: [
        "sh",
        "-eu",
        "-c",
        'path="$1"; while [ "$path" != / ]; do [ ! -L "$path" ] || exit 65; path=${path%/*}; [ -n "$path" ] || path=/; done; [ -f "$1" ] || exit 66; stat -c "%u:%g" "$1"',
        "sqlite-owner",
        dbPath,
      ],
    })
    .pipe(
      Effect.mapError(
        (cause) =>
          new SqlRecoveryUnavailableError({
            message: `Cannot inspect SQLite file ownership for ${target.name}.`,
            service: target.name,
            reason: String(cause),
            remediation:
              "Confirm the SQLite file exists on the planned mount and the provider can inspect it, then retry.",
          }),
      ),
    );
  const user = inspected.exitCode === 0 ? sqliteHelperUser(inspected.stdout) : undefined;
  if (user === undefined) {
    return yield* Effect.fail(
      new SqlRecoveryUnavailableError({
        message: `Cannot establish SQLite file ownership for ${target.name}.`,
        service: target.name,
        reason: `The read-only inspection failed (exit ${inspected.exitCode}) or returned invalid uid:gid. ${inspected.stderr.slice(-8192)}`,
        remediation:
          "Use an existing regular SQLite file without symlinks in its path. Check file permissions and retry; Lando does not guess a named-volume owner or initialize a missing database.",
      }),
    );
  }
  const scratchHost = join(
    deps.paths.ownerSnapshotsDir(helperOwnerKey(deps.applied)),
    "sqlite-helper",
    randomUUID(),
  );
  yield* Effect.try({
    try: () => {
      prepareSqliteScratchDir(scratchHost, user);
    },
    catch: (cause) =>
      new SqlRecoveryUnavailableError({
        message: "Cannot create the SQLite helper scratch directory.",
        service: target.name,
        reason: String(cause),
        remediation: "Check permissions on the Lando user data directory, then retry.",
      }),
  });
  const access = sqliteHelperAccess(covering, deps.applied, {
    source: scratchHost,
    target: SQLITE_HELPER_SCRATCH_TARGET,
  });
  return {
    dbPath,
    scratchHost,
    scratchTarget: SQLITE_HELPER_SCRATCH_TARGET,
    user,
    spec: {
      image,
      ...(access.owner === undefined ? {} : { owner: access.owner }),
      ...(access.mounts === undefined ? {} : { mounts: access.mounts }),
      binds: access.binds,
      user,
      entrypoint: [],
      remove: true,
    },
  } satisfies SqliteHelperContext;
});

export const withSqliteHelper = <A, E, R>(
  deps: SqliteHelperDeps,
  service: SqlPlanService,
  target: SqlFileTarget,
  body: (helper: SqliteHelperContext) => Effect.Effect<A, E, R>,
  options?: { readonly preserveOnFailure?: boolean },
): Effect.Effect<A, E | SqlRecoveryUnavailableError, R> =>
  Effect.acquireUseRelease(
    prepareSqliteHelper(deps, service, target),
    (helper) =>
      Effect.gen(function* () {
        const result = yield* Effect.suspend(() => body(helper));
        yield* Effect.uninterruptible(removeSqliteHelperScratch(helper.scratchHost, target.name));
        return result;
      }),
    (helper, exit) => {
      if (Exit.isSuccess(exit) || options?.preserveOnFailure === true) return Effect.void;
      return removeSqliteHelperScratch(helper.scratchHost, target.name).pipe(
        Effect.catchCause(() =>
          Effect.logWarning(
            `Could not remove SQLite helper scratch at ${helper.scratchHost}; preserving the operation failure.`,
          ),
        ),
      );
    },
  );

export const runSqliteHelper = Effect.fn("Sql.runSqliteHelper")(function* (
  deps: SqliteHelperDeps,
  target: SqlFileTarget,
  context: SqliteHelperContext,
  command: ReadonlyArray<string>,
  options?: {
    readonly stdinStream?: AsyncIterable<Uint8Array>;
    readonly captureStdout?: boolean;
  },
) {
  const spec: EphemeralRunSpec = {
    ...context.spec,
    command,
    ...(options?.stdinStream === undefined ? {} : { stdinStream: options.stdinStream }),
    ...(options?.captureStdout === undefined ? {} : { captureStdout: options.captureStdout }),
  };
  const result = yield* deps.run(spec).pipe(
    Effect.mapError(
      (cause) =>
        new SqlCommandFailedError({
          message: `SQLite helper failed for ${target.name}.`,
          service: target.name,
          command,
          reason: "provider",
          stderrTail: String(cause),
          remediation: "Check provider runtime health with `lando doctor`, then retry.",
        }),
    ),
  );
  if (result.exitCode !== 0) return yield* Effect.fail(helperFailure(target, command, result));
  return result;
});
