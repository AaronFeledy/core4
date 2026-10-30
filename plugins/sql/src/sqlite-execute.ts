import { randomUUID } from "node:crypto";

import { DateTime, Effect, absurd } from "effect";

import { SqlRecoveryUnavailableError, SqlSeedSourceError } from "@lando/sdk/errors";
import { MessageWarnEvent } from "@lando/sdk/events";
import type { DataTransferResult, SnapshotId, SnapshotInfo } from "@lando/sdk/schema";
import { physicalVolumeLockKey } from "@lando/sdk/services";

import { hostFile } from "./command-input.ts";
import type { DbCommandInput, SqlCommandDeps } from "./command-types.ts";
import { compressionFromExportPath, withHostDumpCompression } from "./compression.ts";
import { ensureReadableDump } from "./dump-file.ts";
import { confirmOrFail, publishTree } from "./progress.ts";
import { DEFAULT_SNAPSHOT_KEEP_LATEST } from "./snapshot-retention.ts";
import { resolveSnapshotSource } from "./snapshot-source.ts";
import {
  type SqliteHelperDeps,
  copyHostFile,
  hostFileSize,
  runSqliteHelper,
  sqliteScratchFile,
  withSqliteHelper,
} from "./sqlite-helper.ts";
import { sqliteSidecarPaths } from "./sqlite-path.ts";
import {
  type SqliteSnapshotDeps,
  copySqliteSnapshotArchive,
  createSqliteSnapshot,
  extractSqliteSnapshotArchiveToFile,
  requireSqliteCompatibleSnapshot,
  sqliteSnapshotVolume,
} from "./sqlite-snapshot.ts";
import type { SqlFileTarget } from "./target.ts";
import type { SqlPlanService } from "./views.ts";
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

const atomicReplaceScript =
  'db="$1"; src="$2"; tmp="${db}.lando-import.$3"; cp "$src" "$tmp"; mv -f "$tmp" "$db"; rm -f "${db}-wal" "${db}-shm" "${db}-journal"';

const resetScript = 'rm -f "$1" "$1-wal" "$1-shm" "$1-journal"';

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
          message: `Cannot inspect ${target.name} before a SQLite file replace.`,
          service: target.name,
          reason: String(cause),
          remediation: "Check provider runtime health with `lando doctor`, then retry.",
        }),
    ),
  );
  if (!observed.running) return;
  if (input.force !== true) {
    return yield* Effect.fail(
      new SqlRecoveryUnavailableError({
        message: `Cannot ${input.action} SQLite file on ${target.name} while the service is running.`,
        service: target.name,
        reason: "A running service can keep a WAL writer open across a file replace.",
        remediation: "Stop the service, then retry, or pass --force to replace the file while it is running.",
      }),
    );
  }
  yield* deps.publish(
    MessageWarnEvent.make({
      body: `Replacing the SQLite file on ${target.name} while the service is running. Concurrent writes can be lost. Stop the service instead of passing --force.`,
      timestamp: yield* DateTime.now,
    }),
  );
});

const replaceSqliteFromHost = Effect.fn("Sql.replaceSqliteFromHost")(function* (
  helperDeps: SqliteHelperDeps,
  service: SqlPlanService,
  target: SqlFileTarget,
  sourceHostPath: string,
) {
  yield* withSqliteHelper(helperDeps, service, target, (helper) =>
    Effect.gen(function* () {
      const staged = sqliteScratchFile(helper, ".sqlite");
      yield* copyHostFile(
        sourceHostPath,
        staged.host,
        target.name,
        `Cannot stage a SQLite payload for ${target.name}.`,
      );
      yield* runSqliteHelper(helperDeps, target, helper, [
        "sh",
        "-c",
        atomicReplaceScript,
        "sqlite-replace",
        helper.dbPath,
        staged.target,
        randomUUID(),
      ]);
    }),
  );
});

const importSqlDump = Effect.fn("Sql.importSqlDump")(function* (
  helperDeps: SqliteHelperDeps,
  service: SqlPlanService,
  target: SqlFileTarget,
  workingPath: string,
) {
  yield* withSqliteHelper(helperDeps, service, target, (helper) =>
    Effect.gen(function* () {
      const staged = sqliteScratchFile(helper, ".sqlite");
      yield* runSqliteHelper(helperDeps, target, helper, ["sqlite3", "-bail", staged.target], {
        stdinStream: Bun.file(workingPath).stream(),
      });
      yield* runSqliteHelper(helperDeps, target, helper, [
        "sh",
        "-c",
        atomicReplaceScript,
        "sqlite-replace",
        helper.dbPath,
        staged.target,
        randomUUID(),
      ]);
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
      `Reset will delete ${target.path} and its -wal, -shm, and -journal sidecars on ${target.name}.`,
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

  let prunePolicy: Parameters<SqlCommandDeps["pruneSnapshots"]>[0] | undefined;
  let pruneCandidates: ReadonlyArray<SnapshotInfo> | undefined;
  if (input.action === "prune") {
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
    const keepLatest = input.keepLatest ?? DEFAULT_SNAPSHOT_KEEP_LATEST;
    const snapshots = yield* deps.listSnapshots(filter);
    prunePolicy = { filter, keepLatest };
    pruneCandidates = [...snapshots]
      .filter((snapshot) => snapshot.metadata?.recoveryReason === "manual")
      .sort((left, right) => DateTime.toEpochMillis(right.createdAt) - DateTime.toEpochMillis(left.createdAt))
      .slice(keepLatest);
    if (input.preview !== true) {
      yield* confirmOrFail(
        input,
        deps.confirm,
        target.name,
        steps,
        `Retention will delete ${pruneCandidates.length} snapshot(s) for ${target.name}.`,
      );
    }
  }

  const progress = yield* publishTree(deps.publish, `db:${input.action}`, steps);
  const lockKey = physicalVolumeLockKey(`sql-sqlite:${owner.ownerKey}:${store.store}`);
  let snapshotId: string | undefined;
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
                'sqlite3 "$1" .dump > "$2"',
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
      transfer = yield* withSqliteLock(
        Effect.gen(function* () {
          yield* createSqliteSnapshot(sqlite, deps.plan, service, target, { recoveryReason: "import" });
          return yield* withHostDumpCompression({
            path: file,
            compression,
            ...(dump?.digest === undefined ? {} : { expectedDigest: dump.digest }),
            direction: "import",
            transfer: Effect.fn("Sql.sqliteImport.transfer")(function* (workingPath: string) {
              if (dump?.sqliteDatabase === true) {
                yield* replaceSqliteFromHost(sqlite, service, target, workingPath);
              } else {
                yield* importSqlDump(sqlite, service, target, workingPath);
              }
              return { accelerated: false as const, sizeBytes: hostFileSize(workingPath) };
            }),
          });
        }),
      );
      break;
    case "reset":
      yield* withSqliteLock(
        Effect.gen(function* () {
          yield* createSqliteSnapshot(sqlite, deps.plan, service, target, { recoveryReason: "reset" });
          yield* withSqliteHelper(sqlite, service, target, (helper) =>
            runSqliteHelper(sqlite, target, helper, ["sh", "-c", resetScript, "sqlite-reset", helper.dbPath]),
          );
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
      if (prunePolicy === undefined) return yield* Effect.die(new Error("retention policy was not resolved"));
      prunedSnapshotIds = yield* deps.pruneSnapshots(prunePolicy);
      retentionApplied = true;
      break;
    }
    case "restore": {
      if (restoreSource === undefined) return yield* Effect.die(new Error("Restore source was not resolved"));
      snapshotId = restoreSource.id;
      yield* withSqliteLock(
        Effect.gen(function* () {
          const version = yield* withSqliteHelper(sqlite, service, target, (helper) =>
            runSqliteHelper(sqlite, target, helper, ["sqlite3", helper.dbPath, "SELECT sqlite_version();"], {
              captureStdout: true,
            }).pipe(Effect.map((result) => result.stdout.trim())),
          );
          yield* requireSqliteCompatibleSnapshot(restoreSource, {
            ownerKey: owner.ownerKey,
            service: target.name,
            path: target.path,
            version,
          });
          yield* createSqliteSnapshot(sqlite, deps.plan, service, target, { recoveryReason: "restore" });
          yield* withSqliteHelper(sqlite, service, target, (helper) =>
            Effect.gen(function* () {
              const archive = sqliteScratchFile(helper, ".tar");
              const payload = sqliteScratchFile(helper, ".sqlite");
              yield* copySqliteSnapshotArchive(sqlite, restoreSource, archive.host, target.name);
              yield* extractSqliteSnapshotArchiveToFile(archive.host, payload.host, target.name);
              yield* runSqliteHelper(sqlite, target, helper, [
                "sh",
                "-c",
                atomicReplaceScript,
                "sqlite-replace",
                helper.dbPath,
                payload.target,
                randomUUID(),
              ]);
            }),
          );
        }),
      );
      break;
    }
    default:
      return absurd<never>(input.action);
  }

  yield* progress.complete;
  const seedStatus: "seeded" | undefined = undefined;
  return {
    service: target.name,
    family: target.family,
    steps,
    redactionTokens: [],
    ...(input.action === "import" || input.action === "export" ? { file } : {}),
    ...(snapshotId === undefined ? {} : { snapshotId }),
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
