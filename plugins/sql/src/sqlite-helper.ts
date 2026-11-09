import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { sqliteHelperImage } from "@lando/container-runtime/data-plane";
import { mapFailures } from "@lando/sdk/command-result";
import { SqlCommandFailedError, SqlDatabasePathError, SqlRecoveryUnavailableError } from "@lando/sdk/errors";
import { type AppPlan, planAppIdentity } from "@lando/sdk/schema";
import type { EphemeralRunSpec, ExecResult } from "@lando/sdk/services";
import type { PrivateFileAccess } from "@lando/state-store/private-file-access";
import { Effect, Exit, Result } from "effect";
import type { SqlRuntimeObservationDeps } from "./runtime-observation.ts";
import { removeSqliteHelperScratch } from "./sqlite-helper-files.ts";
import { checkedSqliteHelper } from "./sqlite-helper-run.ts";
import { requireSqliteCoveringMount, sqliteContainerPath, sqliteHelperUser } from "./sqlite-mount.ts";
import type { SqlFileTarget } from "./target.ts";
import type { SqlPlanService } from "./views.ts";

export {
  copyHostFile,
  hostFileSize,
  requireSqliteDatabaseHeader,
  removeSqliteHelperScratch,
  sqliteScratchFile,
} from "./sqlite-helper-files.ts";
export { runSqliteHelper } from "./sqlite-helper-run.ts";

export type SqliteHelperRun = (spec: EphemeralRunSpec) => Effect.Effect<ExecResult, unknown>;
export type SqliteHelperPull = (spec: {
  readonly ref: string;
  readonly policy?: "always" | "missing" | "never";
}) => Effect.Effect<{ readonly digest?: string }, unknown>;
export type SqliteHelperDeps = {
  readonly applied: Pick<AppPlan, "root" | "identity">;
  readonly run: SqliteHelperRun;
  readonly pullArtifact: SqliteHelperPull;
  readonly inspect: SqlRuntimeObservationDeps["inspect"];
  readonly privateFileAccess: PrivateFileAccess;
  readonly paths: { readonly ownerSnapshotsDir: (ownerKey: string) => string };
};
export type SqliteHelperContext = {
  readonly dbPath: string;
  readonly existed: boolean;
  readonly scratchHost: string;
  readonly scratchRoot: string;
  readonly scratchTarget: string;
  readonly user: string;
  readonly spec: Omit<EphemeralRunSpec, "command" | "stdinStream" | "captureStdout">;
};

const sqlitePathRefusals: Readonly<Record<number, SqlDatabasePathError["reason"]>> = {
  65: "symlink",
  66: "missing",
  67: "not-a-file",
  68: "parent-not-directory",
};

const sqliteDatabasePathError = (target: SqlFileTarget, reason: SqlDatabasePathError["reason"]) => {
  const where = `${target.path} on ${target.name}`;
  const details = {
    missing: {
      message: `There is no SQLite database at ${where} yet.`,
      remediation: `Let the app create it (for example by running its migrations), or load one with \`lando db:import <file> --service ${target.name} --yes\`.`,
    },
    symlink: {
      message: `The SQLite path ${where} passes through a symbolic link.`,
      remediation: "Point sqlite.path at the real file inside the app mount, then run `lando start`.",
    },
    "not-a-file": {
      message: `The SQLite path ${where} is not a regular file.`,
      remediation: "Point sqlite.path at the database file, then run `lando start`.",
    },
    "parent-not-directory": {
      message: `A parent of the SQLite path ${where} is not a directory.`,
      remediation:
        "Move the file that occupies that parent path, or point sqlite.path elsewhere and run `lando start`.",
    },
  }[reason];
  return new SqlDatabasePathError({ ...details, service: target.name, path: target.path, reason });
};

export const resolveSqliteHelperImage = (deps: Pick<SqliteHelperDeps, "pullArtifact">) =>
  deps.pullArtifact({ ref: sqliteHelperImage.ref, policy: "missing" }).pipe(
    Effect.flatMap((ref) =>
      ref.digest !== sqliteHelperImage.digest
        ? Effect.fail("The provider returned a different helper image digest.")
        : Effect.succeed(sqliteHelperImage.ref),
    ),
    mapFailures(
      (cause) =>
        new SqlRecoveryUnavailableError({
          message: "Cannot acquire the pinned SQLite helper image.",
          service: "sqlite",
          reason: String(cause),
          remediation: "Check network and registry access, then retry.",
        }),
    ),
  );

export const prepareSqliteHelper = Effect.fn("Sql.prepareSqliteHelper")(function* (
  deps: SqliteHelperDeps,
  service: SqlPlanService,
  target: SqlFileTarget,
  mutation = false,
) {
  const covering = requireSqliteCoveringMount(service, target, mutation);
  if (covering instanceof SqlRecoveryUnavailableError) return yield* Effect.fail(covering);
  const dbPath = sqliteContainerPath(service, target);
  if (dbPath === undefined) return yield* Effect.die("The covering mount requires an app mount.");
  const observed = yield* deps.inspect(target.name).pipe(
    mapFailures(
      (cause) =>
        new SqlRecoveryUnavailableError({
          message: `Cannot inspect ${target.name}.`,
          service: target.name,
          reason: String(cause),
          remediation: "Run lando start, then retry.",
        }),
    ),
  );
  if (observed.containerId === undefined)
    return yield* Effect.fail(
      new SqlRecoveryUnavailableError({
        message: `No service container exists for ${target.name}.`,
        service: target.name,
        reason: "SQLite helpers borrow the service container's realized mounts.",
        remediation: "Run lando start, then retry.",
      }),
    );
  const image = yield* resolveSqliteHelperImage(deps);
  // Reads borrow read-write too: SQLite needs the -shm index beside a WAL database,
  // and `-readonly` still refuses writes to the database itself.
  const mountsFrom = { containerId: observed.containerId, readOnly: false };
  const inspected = yield* checkedSqliteHelper(deps, target, {
    image,
    mountsFrom: { ...mountsFrom, readOnly: true },
    user: "0:0",
    entrypoint: [],
    remove: true,
    captureStdout: true,
    command: [
      "sh",
      "-eu",
      "-c",
      'path="$1"; while [ "$path" != / ]; do [ ! -L "$path" ] || exit 65; path=${path%/*}; [ -n "$path" ] || path=/; done; if [ -f "$1" ]; then stat -c "%u:%g" "$1"; elif [ -e "$1" ]; then exit 67; elif [ "$2" = create ]; then path=${1%/*}; while [ ! -e "$path" ]; do path=${path%/*}; [ -n "$path" ] || path=/; done; [ -d "$path" ] || exit 68; printf "missing\\n"; stat -c "%u:%g" "$path"; else exit 66; fi',
      "sqlite-owner",
      dbPath,
      mutation ? "create" : "existing",
    ],
  }).pipe(
    Effect.catchFilter(
      (error) => {
        const reason =
          error instanceof SqlCommandFailedError && error.exitCode !== undefined
            ? sqlitePathRefusals[error.exitCode]
            : undefined;
        return reason === undefined ? Result.fail(error) : Result.succeed(reason);
      },
      (reason) => Effect.fail(sqliteDatabasePathError(target, reason)),
    ),
  );
  const existed = !inspected.stdout.startsWith("missing\n");
  const user = sqliteHelperUser(existed ? inspected.stdout : inspected.stdout.slice("missing\n".length));
  if (user === undefined)
    return yield* Effect.fail(
      new SqlRecoveryUnavailableError({
        message: `Cannot establish SQLite ownership for ${target.name}.`,
        service: target.name,
        reason: "The helper returned invalid numeric uid:gid.",
        remediation: "Check the database path and permissions, then retry.",
      }),
    );
  const scratch = yield* Effect.tryPromise({
    try: async () => {
      const parent = join(
        deps.paths.ownerSnapshotsDir(planAppIdentity(deps.applied).ownerKey),
        "sqlite-helper",
      );
      await mkdir(parent, { recursive: true, mode: 0o700 });
      await chmod(parent, 0o700);
      await deps.privateFileAccess.enforce(parent);
      await deps.privateFileAccess.verify(parent);
      const operation = await mkdtemp(join(parent, "op-"));
      await chmod(operation, 0o700);
      await deps.privateFileAccess.enforce(operation);
      await deps.privateFileAccess.verify(operation);
      const leaf = join(operation, "work");
      await mkdir(leaf, { mode: 0o777 });
      await chmod(leaf, 0o1777);
      return { host: leaf, root: operation };
    },
    catch: (cause) =>
      new SqlRecoveryUnavailableError({
        message: "Cannot create private SQLite scratch.",
        service: target.name,
        reason: String(cause),
        remediation: "Check Lando user data directory permissions.",
      }),
  });
  const scratchHost = scratch.host;
  const scratchTarget = `/lando-sqlite-${randomUUID()}`;
  return {
    dbPath,
    existed,
    scratchHost,
    scratchRoot: scratch.root,
    scratchTarget,
    user,
    spec: {
      image,
      mountsFrom,
      binds: [{ source: scratchHost, target: scratchTarget }],
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
  options?: { readonly recoveryFile?: () => string | undefined; readonly mutation?: boolean },
) =>
  Effect.acquireUseRelease(
    prepareSqliteHelper(deps, service, target, options?.mutation),
    (helper) => Effect.suspend(() => body(helper)),
    (helper, exit) =>
      removeSqliteHelperScratch(
        helper.scratchRoot,
        target.name,
        Exit.isFailure(exit) ? options?.recoveryFile?.() : undefined,
      ).pipe(
        Effect.catchCause(() =>
          Effect.logWarning("Could not remove SQLite scratch; preserving the operation outcome."),
        ),
      ),
  );
