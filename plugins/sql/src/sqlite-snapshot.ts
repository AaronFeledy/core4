import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { snapshotArchivePath, snapshotPaths } from "@lando/data-mover/snapshot-paths";

import { mapFailures } from "@lando/sdk/command-result";
import { SqlRecoveryUnavailableError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  SNAPSHOT_INFO_VERSION,
  ServiceName,
  SnapshotInfo,
  type SnapshotMetadata,
  snapshotHandle,
} from "@lando/sdk/schema";
import type { DataMover, StateStoreShape } from "@lando/sdk/services";
import { DateTime, Effect, Schema } from "effect";

import { packSqliteTarFile } from "./sqlite-archive.ts";
import { type SqliteHelperDeps, requireSqliteDatabaseHeader } from "./sqlite-helper.ts";
import { sqliteSnapshotStore } from "./sqlite-path.ts";
import type { SqlFileTarget } from "./target.ts";
import { type SqlPlan, sqlPlanDataId, sqlPlanIdentity } from "./views.ts";

export const SqliteSnapshotInfo = Schema.Struct({
  ...SnapshotInfo.fields,
  metadata: Schema.Struct({
    service: ServiceName,
    family: Schema.Literal("sqlite"),
    path: Schema.String,
    version: Schema.String,
    recoveryReason: Schema.Literals(["manual", "reset", "restore", "import"]),
  }),
});

export type SqliteSnapshotDeps = SqliteHelperDeps & {
  readonly paths: SqliteHelperDeps["paths"] & { readonly snapshotsDir: string };
  readonly stateStore: StateStoreShape;
  readonly removeSnapshot?: DataMover["Service"]["removeSnapshot"];
};

export const sqliteSnapshotVolume = (plan: SqlPlan, path: string) => ({
  app: sqlPlanDataId(plan),
  store: sqliteSnapshotStore(path),
});

export const sqliteSnapshotMetadata = (input: {
  readonly service: string;
  readonly path: string;
  readonly version: string;
  readonly recoveryReason: Exclude<SnapshotMetadata["recoveryReason"], "seed">;
}) => ({
  service: ServiceName.make(input.service),
  path: input.path,
  family: "sqlite" as const,
  version: input.version,
  recoveryReason: input.recoveryReason,
});

export const sqliteSnapshotsCompatible = (
  source: SnapshotInfo | undefined,
  context: {
    readonly ownerKey: string;
    readonly appRoot: string;
    readonly service: string;
    readonly path: string;
  },
): boolean =>
  source?.metadata !== undefined &&
  source.format === "tar" &&
  source.store.store === sqliteSnapshotStore(context.path) &&
  source.metadata.family === "sqlite" &&
  source.owner.ownerKey === context.ownerKey &&
  source.owner.appRoot === context.appRoot &&
  source.metadata.service === context.service &&
  source.metadata.path === context.path;

export const requireSqliteCompatibleSnapshot = (
  source: SnapshotInfo | undefined,
  context: {
    readonly ownerKey: string;
    readonly appRoot: string;
    readonly service: string;
    readonly path: string;
  },
): Effect.Effect<void, SqlRecoveryUnavailableError> =>
  sqliteSnapshotsCompatible(source, context)
    ? Effect.void
    : Effect.fail(
        new SqlRecoveryUnavailableError({
          message: `Snapshot ${source?.id ?? "(missing)"} is not compatible with SQLite path ${context.path}.`,
          service: context.service,
          reason: "Snapshot ownership, archive format, store, service, or path does not match.",
          remediation: "Use a matching SQLite snapshot, or move data with logical export and import.",
        }),
      );

export const sqliteSnapshotCatalogFailure = (service: string, message: string, cause: unknown) =>
  new SqlRecoveryUnavailableError({
    message,
    service,
    reason: String(cause),
    remediation: "Inspect the Lando snapshot store under the configured userDataRoot.",
  });

export const persistSqliteSnapshot = Effect.fn("Sql.persistSqliteSnapshot")(function* (
  deps: Pick<SqliteSnapshotDeps, "paths" | "stateStore">,
  plan: SqlPlan,
  target: SqlFileTarget,
  stagedHost: string,
  version: string,
  options: {
    readonly id?: string;
    readonly label?: string;
    readonly recoveryReason?: Exclude<SnapshotMetadata["recoveryReason"], "seed">;
  },
) {
  const owner = sqlPlanIdentity(plan);
  const store = sqliteSnapshotVolume(plan, target.path);
  yield* requireSqliteDatabaseHeader(stagedHost, target.name, "Cannot preserve the SQLite recovery payload.");
  const id = options.id ?? randomUUID();
  const createdAt = yield* DateTime.now;
  const address = { owner, store, id, format: "tar" as const };
  const resolved = yield* snapshotPaths(deps.paths, { ownerKey: owner.ownerKey, store, id }).pipe(
    mapFailures((cause) =>
      sqliteSnapshotCatalogFailure(target.name, "Cannot resolve the SQLite snapshot catalog.", cause),
    ),
  );
  const directory = resolved.store;
  yield* Effect.tryPromise({
    try: () => mkdir(directory, { recursive: true }),
    catch: (cause) =>
      sqliteSnapshotCatalogFailure(
        target.name,
        "Cannot create the SQLite snapshot catalog directory.",
        cause,
      ),
  });
  const archivePath = yield* snapshotArchivePath(deps.paths, address).pipe(
    mapFailures((cause) =>
      sqliteSnapshotCatalogFailure(target.name, "Cannot resolve the SQLite snapshot archive.", cause),
    ),
  );
  const packed = yield* Effect.tryPromise({
    try: () => packSqliteTarFile(stagedHost, archivePath),
    catch: (cause) =>
      sqliteSnapshotCatalogFailure(target.name, "Cannot write the SQLite snapshot archive.", cause),
  });
  const catalogWriteFailure = (cause: unknown) =>
    new SqlRecoveryUnavailableError({
      message: `SQLite recovery archive ${id} was captured but could not be cataloged.`,
      service: target.name,
      reason: String(cause),
      recoveryFile: archivePath,
      remediation: `Preserve ${archivePath}, which contains only ${target.path} on ${target.name}. The snapshot is not cataloged, so db:restore cannot resolve its ID yet. Resolve snapshot-store access before retrying.`,
    });
  const info: typeof SqliteSnapshotInfo.Type = {
    owner,
    id,
    store,
    digest: packed.digest,
    sizeBytes: packed.sizeBytes,
    createdAt,
    format: "tar",
    ...(options.label === undefined ? {} : { label: options.label }),
    metadata: sqliteSnapshotMetadata({
      service: target.name,
      path: target.path,
      version,
      recoveryReason: options.recoveryReason ?? "manual",
    }),
  };
  const bucket = yield* deps.stateStore
    .open({
      root: { path: AbsolutePath.make(directory) },
      key: `${id}.json`,
      schema: SqliteSnapshotInfo,
      version: SNAPSHOT_INFO_VERSION,
      codec: "json",
      onCorrupt: "fail",
    })
    .pipe(mapFailures(catalogWriteFailure));
  yield* bucket.set(info).pipe(mapFailures(catalogWriteFailure));
  return snapshotHandle(info);
});
