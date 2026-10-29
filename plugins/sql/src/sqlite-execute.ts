import { join } from "node:path";

import { DateTime, Effect, absurd } from "effect";

import { SqlRecoveryUnavailableError, SqlSeedSourceError } from "@lando/sdk/errors";
import type { DataTransferResult, SnapshotId, SnapshotInfo } from "@lando/sdk/schema";
import { physicalVolumeLockKey } from "@lando/sdk/services";

import type { DbCommandInput, SqlCommandDeps } from "./command-types.ts";
import { hostFile } from "./command-input.ts";
import { compressionFromExportPath } from "./compression.ts";
import { withHostDumpCompression } from "./compression.ts";
import { ensureReadableDump } from "./dump-file.ts";
import { confirmOrFail, publishTree } from "./progress.ts";
import { DEFAULT_SNAPSHOT_KEEP_LATEST } from "./snapshot-retention.ts";
import { resolveSnapshotSource } from "./snapshot-source.ts";
import { isSqliteDatabaseHeader } from "./sqlite-header.ts";
import { prepareSqliteHelper, runSqliteHelper, type SqliteHelperDeps } from "./sqlite-helper.ts";
import { sqliteSidecarPaths } from "./sqlite-path.ts";
import {
  createSqliteSnapshot,
  extractSqliteSnapshotArchive,
  readSqliteSnapshotArchive,
  requireSqliteCompatibleSnapshot,
  sqliteSnapshotVolume,
  type SqliteSnapshotDeps,
} from "./sqlite-snapshot.ts";
import type { SqlFileTarget } from "./target.ts";
import { sqlPlanIdentity } from "./views.ts";

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
  'db="$1"; src="$2"; tmp="${db}.lando-import"; cp "$src" "$tmp"; if [ -f "$db" ]; then sqlite3 "$db" "PRAGMA wal_checkpoint(TRUNCATE);" || true; fi; mv -f "$tmp" "$db"; rm -f "${db}-wal" "${db}-shm" "${db}-journal"';

const resetScript = 'rm -f "$1" "$1-wal" "$1-shm" "$1-journal"';

const writeScratchFile = (path: string, bytes: Uint8Array, service: string) =>
  Effect.tryPromise({
    try: () => Bun.write(path, bytes),
    catch: (cause) =>
      new SqlRecoveryUnavailableError({
        message: `Cannot stage a SQLite payload for ${service}.`,
        service,
        reason: String(cause),
        remediation: "Check permissions on the Lando scratch directory, then retry.",
      }),
  });

const replaceSqliteFile = Effect.fn("Sql.replaceSqliteFile")(function* (
  helperDeps: SqliteHelperDeps,
  service: Parameters<typeof prepareSqliteHelper>[1],
  target: SqlFileTarget,
  payload: Uint8Array,
) {
  const helper = yield* prepareSqliteHelper(helperDeps, service, target);
  const staged = join(helper.scratchHost, "import.sqlite");
  yield* writeScratchFile(staged, payload, target.name);
  yield* runSqliteHelper(helperDeps, target, helper, [
    "sh",
    "-c",
    atomicReplaceScript,
    "sqlite-replace",
    helper.dbPath,
    `${helper.scratchTarget}/import.sqlite`,
  ]);
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
  const sqlite = yield* requireSqliteRuntime(deps, target.name);
  const owner = sqlPlanIdentity(deps.plan);
  const store = sqliteSnapshotVolume(deps.plan, target.path);
  const file = hostFile(deps.plan, { ...input, service: target.name });
  const dump =
    input.action === "import" ? yield* ensureReadableDump(file, deps.plan.root) : undefined;
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
      ...(deps.plan.identity?.repoGroupKey === undefined ? {} : { repoGroupKey: deps.plan.identity.repoGroupKey }),
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
          const helper = yield* prepareSqliteHelper(sqlite, service, target);
          const result = yield* runSqliteHelper(sqlite, target, helper, ["sqlite3", helper.dbPath, ".dump"], {
            captureStdout: true,
          });
          yield* Effect.tryPromise({
            try: () => Bun.write(workingPath, result.stdout),
            catch: (cause) =>
              new SqlRecoveryUnavailableError({
                message: `Cannot write SQLite dump ${workingPath}.`,
                service: target.name,
                reason: String(cause),
                remediation: "Check host disk space and retry the export.",
              }),
          });
          return { accelerated: false as const, sizeBytes: result.stdout.length };
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
              const payload = new Uint8Array(yield* Effect.tryPromise({
                try: () => Bun.file(workingPath).arrayBuffer(),
                catch: (cause) =>
                  new SqlRecoveryUnavailableError({
                    message: `Cannot read import payload ${workingPath}.`,
                    service: target.name,
                    reason: String(cause),
                    remediation: "Check the dump path and retry.",
                  }),
              }));
              if (isSqliteDatabaseHeader(payload)) {
                yield* replaceSqliteFile(sqlite, service, target, payload);
              } else {
                const helper = yield* prepareSqliteHelper(sqlite, service, target);
                yield* runSqliteHelper(sqlite, target, helper, ["sqlite3", "-bail", helper.dbPath], {
                  stdinStream: Bun.file(workingPath).stream(),
                });
              }
              return { accelerated: false as const, sizeBytes: payload.byteLength };
            }),
          });
        }),
      );
      break;
    case "reset":
      yield* withSqliteLock(
        Effect.gen(function* () {
          yield* createSqliteSnapshot(sqlite, deps.plan, service, target, { recoveryReason: "reset" });
          const helper = yield* prepareSqliteHelper(sqlite, service, target);
          yield* runSqliteHelper(sqlite, target, helper, ["sh", "-c", resetScript, "sqlite-reset", helper.dbPath]);
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
        ...(deps.plan.identity?.repoGroupKey === undefined ? {} : { repoGroupKey: deps.plan.identity.repoGroupKey }),
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
      const helper = yield* prepareSqliteHelper(sqlite, service, target);
      const versionResult = yield* runSqliteHelper(
        sqlite,
        target,
        helper,
        ["sqlite3", helper.dbPath, "SELECT sqlite_version();"],
        { captureStdout: true },
      );
      yield* requireSqliteCompatibleSnapshot(restoreSource, {
        ownerKey: owner.ownerKey,
        service: target.name,
        path: target.path,
        version: versionResult.stdout.trim(),
      });
      yield* withSqliteLock(
        Effect.gen(function* () {
          yield* createSqliteSnapshot(sqlite, deps.plan, service, target, { recoveryReason: "restore" });
          const archive = yield* readSqliteSnapshotArchive(sqlite, restoreSource, target.name);
          const payload = yield* extractSqliteSnapshotArchive(archive, target.name);
          yield* replaceSqliteFile(sqlite, service, target, payload);
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
