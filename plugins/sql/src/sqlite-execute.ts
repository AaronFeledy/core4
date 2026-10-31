import { Effect, absurd } from "effect";

import { SqlRecoveryUnavailableError, SqlSeedSourceError } from "@lando/sdk/errors";
import { SqlRecoveryOperationError } from "@lando/sdk/errors";
import {
  type DataTransferResult,
  ServiceName,
  type SnapshotFilter,
  type SnapshotId,
  type SnapshotInfo,
  snapshotHandle,
} from "@lando/sdk/schema";
import { physicalVolumeLockKey } from "@lando/sdk/services";

import { hostFile } from "./command-input.ts";
import type { DbCommandInput, SqlCommandDeps } from "./command-types.ts";
import { compressionFromExportPath, withHostDumpCompression } from "./compression.ts";
import { ensureReadableDump } from "./dump-file.ts";
import { confirmOrFail, publishTree } from "./progress.ts";
import { DEFAULT_SNAPSHOT_KEEP_LATEST } from "./snapshot-retention.ts";
import { resolveSnapshotSource } from "./snapshot-source.ts";
import { isSqliteDatabaseHeader } from "./sqlite-header.ts";
import {
  copyHostFile,
  hostFileSize,
  requireSqliteDatabaseHeader,
  runSqliteHelper,
  sqliteScratchFile,
  withSqliteHelper,
} from "./sqlite-helper.ts";
import { requireSqliteIntegrity, sqliteScratchOnlyHelper } from "./sqlite-integrity.ts";
import { mutateSqlite } from "./sqlite-mutation.ts";
import { sqliteSidecarPaths } from "./sqlite-path.ts";
import { sqliteManualPruneSelection, sqliteSnapshotCatalogKey } from "./sqlite-retention.ts";
import {
  type SqliteSnapshotDeps,
  copySqliteSnapshotArchive,
  createSqliteSnapshot,
  extractSqliteSnapshotArchiveToFile,
  requireSqliteCompatibleSnapshot,
  sqliteSnapshotVolume,
  stageVerifiedSqliteImport,
} from "./sqlite-snapshot.ts";
import type { SqlFileTarget } from "./target.ts";
import { sqlPlanIdentity } from "./views.ts";

const LIVE_WRITE_ACTIONS = new Set<DbCommandInput["action"]>(["import", "restore", "reset"]);

const requireSqliteRuntime = (
  deps: SqlCommandDeps,
  service: string,
): Effect.Effect<SqliteSnapshotDeps, SqlRecoveryUnavailableError> =>
  deps.sqlite === undefined
    ? Effect.fail(
        new SqlRecoveryUnavailableError({
          message: `SQLite helper runtime is unavailable for ${service}.`,
          service,
          reason: "The command runtime did not provide a pinned sqlite3 helper.",
          remediation: "Retry from `lando db:*` after the SQL plugin is fully composed.",
        }),
      )
    : Effect.succeed(deps.sqlite);

const refuseRunningSqliteWriter = Effect.fn("Sql.refuseRunningSqliteWriter")(function* (
  deps: SqlCommandDeps,
  input: DbCommandInput,
  target: SqlFileTarget,
) {
  if (!LIVE_WRITE_ACTIONS.has(input.action)) return;
  const observed = yield* deps.inspect(target.name).pipe(
    Effect.mapError(
      (cause) =>
        new SqlRecoveryUnavailableError({
          message: `Cannot inspect ${target.name} before SQLite mutation.`,
          service: target.name,
          reason: String(cause),
          remediation: "Check provider runtime health with lando doctor, then retry.",
        }),
    ),
  );
  if (observed.running)
    return yield* Effect.fail(
      new SqlRecoveryUnavailableError({
        message: `Cannot ${input.action} SQLite data on ${target.name} while the service is running.`,
        service: target.name,
        reason: "Stop application activity before acquiring the SQLite engine lock.",
        remediation:
          "Stop the service and close external SQLite clients, then retry. --force and --yes do not bypass safety checks.",
      }),
    );
});

export const executeSqliteCommand = Effect.fn("Sql.executeSqliteCommand")(function* (
  deps: SqlCommandDeps,
  input: DbCommandInput,
  target: SqlFileTarget,
) {
  const service = deps.plan.services[target.name];
  if (service === undefined) {
    return yield* Effect.fail(
      new SqlRecoveryUnavailableError({
        message: `No SQL service named ${target.name}.`,
        service: target.name,
        reason: "The applied plan does not include this SQLite service.",
        remediation: "Run `lando start` to apply the plan, then retry.",
      }),
    );
  }
  if (input.action === "seed") {
    return yield* Effect.fail(
      new SqlSeedSourceError({
        message: `Seed is not supported for SQLite file target ${target.name}.`,
        service: target.name,
        sourceFamily: "sqlite",
        remediation: "Use db:import, db:restore, or db:reset against the SQLite file instead.",
      }),
    );
  }
  yield* refuseRunningSqliteWriter(deps, input, target);
  const sqlite = yield* requireSqliteRuntime(deps, target.name);
  const owner = sqlPlanIdentity(deps.plan);
  const store = sqliteSnapshotVolume(deps.plan, target.path);
  const file = hostFile(deps.plan, { ...input, service: target.name });
  const dump = input.action === "import" ? yield* ensureReadableDump(file, deps.plan.root) : undefined;
  const compression = dump?.compression ?? compressionFromExportPath(file);
  const steps = [
    {
      id: input.action,
      label: `${input.action} ${target.name}`,
      target: target.name,
      destructive: input.action === "import" || input.action === "reset" || input.action === "restore",
    },
  ];
  if (input.action === "import") {
    yield* confirmOrFail(
      input,
      deps.confirm,
      target.name,
      steps,
      `Import will replace SQLite data at ${target.path} on ${target.name}.`,
    );
  }
  if (input.action === "reset") {
    yield* confirmOrFail(
      input,
      deps.confirm,
      target.name,
      steps,
      `Reset will empty ${target.path} on ${target.name}. Recovery covers only this SQLite database; service, configuration, and other databases are preserved. No migrations or seeds will run.`,
    );
  }
  if (input.action === "restore") {
    yield* confirmOrFail(
      input,
      deps.confirm,
      target.name,
      steps,
      `Restore will replace SQLite data at ${target.path} on ${target.name}.`,
    );
  }

  let restoreSource: SnapshotInfo | undefined;
  if (input.action === "restore") {
    const scope = yield* resolveSnapshotSource({
      app: deps.plan.id,
      store: store.store,
      ownerKey: owner.ownerKey,
      service: target.name,
      hostCwd: input.hostCwd ?? process.cwd(),
      canonicalizePath: deps.canonicalizeSourcePath,
    });
    restoreSource = yield* deps.resolveSnapshot(input.snapshotId ?? "", scope);
  }

  let pruneFilter: SnapshotFilter | undefined;
  let pruneCandidates: ReadonlyArray<SnapshotInfo> | undefined;
  if (input.action === "prune") {
    const sourceFilter = yield* resolveSnapshotSource({
      app: deps.plan.id,
      store: store.store,
      ownerKey: owner.ownerKey,
      ...(deps.plan.identity?.repoGroupKey === undefined
        ? {}
        : { repoGroupKey: deps.plan.identity.repoGroupKey }),
      service: target.name,
      ...(input.fromApp === undefined ? {} : { fromApp: input.fromApp }),
      ...(input.fromPath === undefined ? {} : { fromPath: input.fromPath }),
      hostCwd: input.hostCwd ?? process.cwd(),
      canonicalizePath: deps.canonicalizeSourcePath,
    });
    const filter = { ...sourceFilter, service: ServiceName.make(target.name) };
    const keepLatest = input.keepLatest ?? DEFAULT_SNAPSHOT_KEEP_LATEST;
    const snapshots = yield* deps.listSnapshots(filter);
    pruneFilter = filter;
    pruneCandidates = sqliteManualPruneSelection(snapshots, keepLatest).candidates;
    if (input.preview !== true && sqlite.removeSnapshot === undefined)
      return yield* Effect.fail(
        new SqlRecoveryUnavailableError({
          message: "SQLite snapshot removal is unavailable.",
          service: target.name,
          reason: "The snapshot catalog runtime did not provide exact snapshot removal.",
          remediation:
            "Use the standard database command runtime to remove the confirmed snapshot IDs safely.",
        }),
      );
    if (input.preview !== true) {
      yield* confirmOrFail(
        input,
        deps.confirm,
        target.name,
        steps,
        `Retention will delete ${pruneCandidates.length} manual SQLite snapshot(s) for ${target.name} from ${input.fromPath ?? input.fromApp ?? owner.appRoot}, keeping ${keepLatest} per recorded physical target.`,
      );
    }
  }

  const progress = yield* publishTree(deps.publish, `db:${input.action}`, steps);
  const lockKey = physicalVolumeLockKey(`sql-sqlite:${owner.ownerKey}:${store.store}`);
  let snapshotId: string | undefined;
  let recoverySnapshotId: string | undefined;
  let listedSnapshots: ReadonlyArray<SnapshotInfo> | undefined;
  let prunedSnapshotIds: ReadonlyArray<SnapshotId> | undefined;
  let retentionApplied: boolean | undefined;
  let transfer: DataTransferResult | undefined;

  const withSqliteLock = <A, E>(body: Effect.Effect<A, E>) => sqlite.stateStore.withLock(lockKey, body);

  switch (input.action) {
    case "export":
      transfer = yield* withHostDumpCompression({
        path: file,
        compression,
        ...(input.compressionLevel === undefined ? {} : { compressionLevel: input.compressionLevel }),
        direction: "export",
        transfer: Effect.fn("Sql.sqliteExport.transfer")(function* (workingPath: string) {
          yield* withSqliteHelper(sqlite, service, target, (helper) =>
            Effect.gen(function* () {
              const dumpFile = sqliteScratchFile(helper, ".sql");
              yield* runSqliteHelper(sqlite, target, helper, [
                "sh",
                "-c",
                'sqlite3 -bail -readonly -ifexists "$1" .dump > "$2"',
                "sqlite-dump",
                helper.dbPath,
                dumpFile.target,
              ]);
              yield* copyHostFile(
                dumpFile.host,
                workingPath,
                target.name,
                `Cannot write SQLite dump ${workingPath}.`,
              );
            }),
          );
          return { accelerated: false as const, sizeBytes: hostFileSize(workingPath) };
        }),
      });
      break;
    case "import":
      transfer = yield* withHostDumpCompression({
        path: file,
        compression,
        ...(dump?.digest === undefined ? {} : { expectedDigest: dump.digest }),
        direction: "import",
        transfer: Effect.fn("Sql.sqliteImport.transfer")(function* (workingPath: string, digest?: string) {
          recoverySnapshotId = yield* withSqliteLock(
            Effect.gen(function* () {
              yield* refuseRunningSqliteWriter(deps, input, target);
              return yield* mutateSqlite(deps, sqlite, service, target, "import", (helper) =>
                Effect.gen(function* () {
                  const stagedInput = sqliteScratchFile(helper, ".input");
                  yield* stageVerifiedSqliteImport(
                    workingPath,
                    stagedInput.host,
                    digest ?? dump?.digest ?? "",
                    target.name,
                  );
                  const prefix = new Uint8Array(
                    yield* Effect.promise(() => Bun.file(stagedInput.host).slice(0, 16).arrayBuffer()),
                  );
                  if (isSqliteDatabaseHeader(prefix)) {
                    yield* requireSqliteDatabaseHeader(
                      stagedInput.host,
                      target.name,
                      "Raw import did not produce a regular SQLite database.",
                    );
                    yield* requireSqliteIntegrity(sqlite, target, helper, stagedInput.target);
                    return stagedInput.target;
                  }
                  const database = sqliteScratchFile(helper, ".sqlite");
                  const stagingHelper = sqliteScratchOnlyHelper(helper);
                  yield* runSqliteHelper(
                    sqlite,
                    target,
                    stagingHelper,
                    ["sqlite3", "-bail", database.target],
                    {
                      stdinStream: Bun.file(stagedInput.host).stream(),
                    },
                  );
                  yield* requireSqliteDatabaseHeader(
                    database.host,
                    target.name,
                    "SQL import did not produce a SQLite database.",
                  );
                  yield* requireSqliteIntegrity(sqlite, target, helper, database.target);
                  return database.target;
                }),
              );
            }),
          );
          return { accelerated: false as const, sizeBytes: hostFileSize(workingPath) };
        }),
      });
      break;
    case "reset":
      recoverySnapshotId = yield* withSqliteLock(
        Effect.gen(function* () {
          yield* refuseRunningSqliteWriter(deps, input, target);
          return yield* mutateSqlite(deps, sqlite, service, target, "reset");
        }),
      );
      break;
    case "snapshot": {
      const handle = yield* withSqliteLock(
        createSqliteSnapshot(sqlite, deps.plan, service, target, {
          ...(input.label === undefined ? {} : { label: input.label }),
          recoveryReason: "manual",
        }),
      );
      snapshotId = handle.id;
      break;
    }
    case "snapshots": {
      const filter = yield* resolveSnapshotSource({
        app: deps.plan.id,
        store: store.store,
        ownerKey: owner.ownerKey,
        ...(deps.plan.identity?.repoGroupKey === undefined
          ? {}
          : { repoGroupKey: deps.plan.identity.repoGroupKey }),
        service: target.name,
        ...(input.fromApp === undefined ? {} : { fromApp: input.fromApp }),
        ...(input.fromPath === undefined ? {} : { fromPath: input.fromPath }),
        hostCwd: input.hostCwd ?? process.cwd(),
        canonicalizePath: deps.canonicalizeSourcePath,
      });
      listedSnapshots = yield* deps.listSnapshots(filter);
      break;
    }
    case "prune": {
      if (input.preview === true) {
        prunedSnapshotIds = [];
        retentionApplied = false;
        break;
      }
      if (pruneFilter === undefined || sqlite.removeSnapshot === undefined)
        return yield* Effect.die(new Error("retention was not prepared"));
      const filter = pruneFilter;
      const remove = sqlite.removeSnapshot;
      const approved = new Map(
        (pruneCandidates ?? []).map((snapshot) => [sqliteSnapshotCatalogKey(snapshot), snapshot]),
      );
      prunedSnapshotIds = yield* withSqliteLock(
        Effect.gen(function* () {
          const current = yield* deps.listSnapshots(filter);
          const confirmed = current.filter((snapshot) => {
            const previous = approved.get(sqliteSnapshotCatalogKey(snapshot));
            return (
              previous !== undefined &&
              snapshot.metadata?.family === "sqlite" &&
              snapshot.metadata.recoveryReason === "manual" &&
              snapshot.digest === previous.digest &&
              snapshot.metadata.volumeInstanceId === previous.metadata?.volumeInstanceId
            );
          });
          return yield* Effect.forEach(confirmed, (snapshot) =>
            remove(snapshotHandle(snapshot)).pipe(Effect.as(snapshot.id)),
          );
        }),
      );
      retentionApplied = true;
      break;
    }
    case "restore": {
      if (restoreSource === undefined) return yield* Effect.die(new Error("Restore source was not resolved"));
      snapshotId = restoreSource.id;
      yield* withSqliteLock(
        Effect.gen(function* () {
          yield* refuseRunningSqliteWriter(deps, input, target);
          recoverySnapshotId = yield* mutateSqlite(
            deps,
            sqlite,
            service,
            target,
            "restore",
            (helper, targetIdentity) =>
              Effect.gen(function* () {
                const version = (yield* runSqliteHelper(
                  sqlite,
                  target,
                  helper,
                  ["sqlite3", "-readonly", "-ifexists", helper.dbPath, "SELECT sqlite_version();"],
                  { captureStdout: true },
                )).stdout.trim();
                yield* requireSqliteCompatibleSnapshot(restoreSource, {
                  ownerKey: owner.ownerKey,
                  appRoot: owner.appRoot,
                  service: target.name,
                  path: target.path,
                  version,
                  targetIdentity,
                });
                const archive = sqliteScratchFile(helper, ".tar");
                const payload = sqliteScratchFile(helper, ".sqlite");
                yield* copySqliteSnapshotArchive(sqlite, restoreSource, archive.host, target.name);
                yield* extractSqliteSnapshotArchiveToFile(archive.host, payload.host, target.name);
                yield* requireSqliteDatabaseHeader(
                  payload.host,
                  target.name,
                  "Restore did not produce a regular SQLite database.",
                );
                yield* requireSqliteIntegrity(sqlite, target, helper, payload.target);
                return payload.target;
              }),
            restoreSource.id,
          );
        }),
      );
      break;
    }
    default:
      return absurd<never>(input.action);
  }

  yield* progress.complete.pipe(
    Effect.mapError((cause) =>
      recoverySnapshotId === undefined
        ? cause
        : new SqlRecoveryOperationError({
            message: `${input.action} completed for ${target.path}, but completion notification failed.`,
            service: target.name,
            operation: input.action === "import" || input.action === "restore" ? input.action : "reset",
            recoverySnapshotId,
            cause,
            remediation: `Recovery ${recoverySnapshotId} covers only ${target.path} on ${target.name}. Check database state before retrying.`,
          }),
    ),
  );
  const seedStatus: "seeded" | undefined = undefined;
  return {
    service: target.name,
    family: target.family,
    steps,
    redactionTokens: [],
    ...(input.action === "import" || input.action === "export" ? { file } : {}),
    ...(snapshotId === undefined ? {} : { snapshotId }),
    ...(recoverySnapshotId === undefined ? {} : { recoverySnapshotId, recoveryPath: target.path }),
    ...(listedSnapshots === undefined ? {} : { snapshots: listedSnapshots }),
    ...(pruneCandidates === undefined
      ? {}
      : { pruneCandidates: pruneCandidates.map((snapshot) => snapshot.id) }),
    ...(prunedSnapshotIds === undefined ? {} : { prunedSnapshotIds }),
    ...(retentionApplied === undefined ? {} : { retentionApplied }),
    ...(seedStatus === undefined ? {} : { seedStatus }),
    ...(transfer?.accelerated === undefined ? {} : { accelerated: transfer.accelerated }),
    ...(transfer?.sizeBytes === undefined ? {} : { sizeBytes: transfer.sizeBytes }),
  };
});

export const sqliteSidecarNames = sqliteSidecarPaths;
