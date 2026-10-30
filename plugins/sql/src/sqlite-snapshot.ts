import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { SqlRecoveryUnavailableError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  ServiceName,
  SnapshotInfo,
  type SnapshotMetadata,
  snapshotHandle,
} from "@lando/sdk/schema";
import type { StateStoreShape } from "@lando/sdk/services";
import { DateTime, Effect } from "effect";

import { packSqliteTarFile, unpackSqliteTarFile } from "./sqlite-archive.ts";
import {
  type SqliteHelperContext,
  type SqliteHelperDeps,
  copyHostFile,
  runSqliteHelper,
  sqliteScratchFile,
  withSqliteHelper,
} from "./sqlite-helper.ts";
import { sqliteSnapshotStore } from "./sqlite-path.ts";
import type { SqlFileTarget } from "./target.ts";
import { type SqlPlan, type SqlPlanService, sqlPlanIdentity } from "./views.ts";

const SQLITE_COMPAT_IDENTITY = "sqlite";

export type SqliteSnapshotDeps = SqliteHelperDeps & {
  readonly stateStore: StateStoreShape;
};

export const sqliteSnapshotVolume = (plan: SqlPlan, path: string) => ({
  app: AppId.make(plan.id),
  store: sqliteSnapshotStore(path),
});

export const sqliteSnapshotMetadata = (input: {
  readonly service: string;
  readonly path: string;
  readonly version: string;
  readonly recoveryReason: SnapshotMetadata["recoveryReason"];
}): SnapshotMetadata => ({
  service: ServiceName.make(input.service),
  volumeInstanceId: input.path,
  family: "sqlite",
  version: input.version,
  imageIdentity: SQLITE_COMPAT_IDENTITY,
  recoveryReason: input.recoveryReason,
});

export const sqliteSnapshotsCompatible = (
  source: SnapshotInfo | undefined,
  context: {
    readonly ownerKey: string;
    readonly service: string;
    readonly path: string;
    readonly version: string;
  },
): boolean =>
  source?.metadata !== undefined &&
  source.metadata.family === "sqlite" &&
  source.metadata.version === context.version &&
  source.owner.ownerKey === context.ownerKey &&
  source.metadata.service === context.service &&
  source.metadata.volumeInstanceId === context.path;

export const requireSqliteCompatibleSnapshot = (
  source: SnapshotInfo | undefined,
  context: {
    readonly ownerKey: string;
    readonly service: string;
    readonly path: string;
    readonly version: string;
  },
): Effect.Effect<void, SqlRecoveryUnavailableError> =>
  sqliteSnapshotsCompatible(source, context)
    ? Effect.void
    : Effect.fail(
        new SqlRecoveryUnavailableError({
          message: `Snapshot ${source?.id ?? "(missing)"} is not compatible with SQLite path ${context.path}.`,
          service: context.service,
          reason: "Snapshot ownership, service, sqlite_version, or path does not match.",
          remediation: "Use a matching SQLite snapshot, or move data with logical export and import.",
        }),
      );

const catalogFailure = (service: string, message: string, cause: unknown) =>
  new SqlRecoveryUnavailableError({
    message,
    service,
    reason: String(cause),
    remediation: "Inspect the Lando snapshot store under the configured userDataRoot.",
  });

const observeSqliteVersion = Effect.fn("Sql.observeSqliteVersion")(function* (
  deps: SqliteHelperDeps,
  target: SqlFileTarget,
  helper: SqliteHelperContext,
) {
  const result = yield* runSqliteHelper(
    deps,
    target,
    helper,
    ["sqlite3", helper.dbPath, "SELECT sqlite_version();"],
    {
      captureStdout: true,
    },
  );
  const version = result.stdout.trim();
  if (version.length === 0) {
    return yield* Effect.fail(
      new SqlRecoveryUnavailableError({
        message: `Cannot read sqlite_version() for ${target.name}.`,
        service: target.name,
        reason: "The helper returned an empty version string.",
        remediation: "Confirm the SQLite file exists and retry.",
      }),
    );
  }
  return version;
});

export const createSqliteSnapshot = Effect.fn("Sql.createSqliteSnapshot")(function* (
  deps: SqliteSnapshotDeps,
  plan: SqlPlan,
  service: SqlPlanService,
  target: SqlFileTarget,
  options?: { readonly label?: string; readonly recoveryReason?: SnapshotMetadata["recoveryReason"] },
) {
  const owner = sqlPlanIdentity(plan);
  const store = sqliteSnapshotVolume(plan, target.path);
  return yield* withSqliteHelper(deps, service, target, (helper) =>
    Effect.gen(function* () {
      const version = yield* observeSqliteVersion(deps, target, helper);
      const staged = sqliteScratchFile(helper, ".sqlite");
      yield* runSqliteHelper(deps, target, helper, [
        "sqlite3",
        helper.dbPath,
        `VACUUM INTO '${staged.target}';`,
      ]);
      const id = randomUUID();
      const createdAt = yield* DateTime.now;
      const directory = join(deps.paths.ownerSnapshotsDir(owner.ownerKey), store.store);
      yield* Effect.tryPromise({
        try: () => mkdir(directory, { recursive: true }),
        catch: (cause) =>
          catalogFailure(target.name, "Cannot create the SQLite snapshot catalog directory.", cause),
      });
      const archivePath = join(directory, `${id}.tar`);
      const packed = yield* Effect.tryPromise({
        try: () => packSqliteTarFile(staged.host, archivePath),
        catch: (cause) => catalogFailure(target.name, "Cannot write the SQLite snapshot archive.", cause),
      });
      const info: SnapshotInfo = {
        owner,
        id,
        store,
        digest: packed.digest,
        sizeBytes: packed.sizeBytes,
        createdAt,
        format: "tar",
        ...(options?.label === undefined ? {} : { label: options.label }),
        metadata: sqliteSnapshotMetadata({
          service: target.name,
          path: target.path,
          version,
          recoveryReason: options?.recoveryReason ?? "manual",
        }),
      };
      const bucket = yield* deps.stateStore
        .open({
          root: { path: AbsolutePath.make(directory) },
          key: `${id}.json`,
          schema: SnapshotInfo,
          version: 1,
          codec: "json",
          onCorrupt: "fail",
        })
        .pipe(
          Effect.mapError((cause) =>
            catalogFailure(target.name, "Cannot open the SQLite snapshot sidecar.", cause),
          ),
        );
      yield* bucket
        .set(info)
        .pipe(
          Effect.mapError((cause) =>
            catalogFailure(target.name, "Cannot write the SQLite snapshot sidecar.", cause),
          ),
        );
      return snapshotHandle(info);
    }),
  );
});

export const extractSqliteSnapshotArchiveToFile = (
  archivePath: string,
  destPath: string,
  service: string,
): Effect.Effect<void, SqlRecoveryUnavailableError> =>
  Effect.tryPromise({
    try: async () => {
      const ok = await unpackSqliteTarFile(archivePath, destPath);
      if (!ok) throw new Error("The archive is missing a SQLite payload.");
    },
    catch: (cause) =>
      new SqlRecoveryUnavailableError({
        message: `Snapshot archive for ${service} is not a SQLite database tar.`,
        service,
        reason: String(cause),
        remediation: "Use a matching SQLite snapshot created by lando db:snapshot.",
      }),
  });

export const copySqliteSnapshotArchive = (
  deps: SqliteSnapshotDeps,
  info: SnapshotInfo,
  destPath: string,
  service: string,
): Effect.Effect<void, SqlRecoveryUnavailableError> => {
  const directory = join(deps.paths.ownerSnapshotsDir(info.owner.ownerKey), info.store.store);
  return copyHostFile(
    join(directory, `${info.id}.${info.format ?? "tar"}`),
    destPath,
    service,
    "Cannot read the SQLite snapshot archive.",
  );
};
