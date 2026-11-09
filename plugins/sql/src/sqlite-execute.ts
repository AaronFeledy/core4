import { Effect, absurd } from "effect";

import { mapFailures } from "@lando/sdk/command-result";
import { SqlRecoveryOperationError } from "@lando/sdk/errors";
import {
  type DataTransferResult,
  type SnapshotId,
  type SnapshotInfo,
  snapshotHandle,
} from "@lando/sdk/schema";

import { exportCompression } from "./command-input.ts";
import type { DbCommandInput, SqlCommandDeps } from "./command-types.ts";
import { resolveSnapshotSource } from "./snapshot-source.ts";
import { prepareSqliteCommand } from "./sqlite-command-preparation.ts";
import { exportSqliteDump } from "./sqlite-dump.ts";
import { hostFileSize, requireSqliteDatabaseHeader, sqliteScratchFile } from "./sqlite-helper.ts";
import { prepareSqliteImportPayload } from "./sqlite-import-payload.ts";
import { requireSqliteIntegrity } from "./sqlite-integrity.ts";
import { mutateSqlite } from "./sqlite-mutation.ts";
import { sqliteSidecarPaths } from "./sqlite-path.ts";
import { sqliteSnapshotCatalogKey } from "./sqlite-retention.ts";
import { createSqliteSnapshot } from "./sqlite-snapshot-capture.ts";
import { copySqliteSnapshotArchive, extractSqliteSnapshotArchiveToFile } from "./sqlite-snapshot-transfer.ts";
import { requireSqliteCompatibleSnapshot } from "./sqlite-snapshot.ts";
import type { SqlFileTarget } from "./target.ts";

export const executeSqliteCommand = Effect.fn("Sql.executeSqliteCommand")(function* (
  deps: SqlCommandDeps,
  input: DbCommandInput,
  target: SqlFileTarget,
) {
  const {
    action,
    service,
    sqlite,
    owner,
    store,
    file,
    dumpStdio,
    steps,
    restoreSource,
    pruneFilter,
    pruneCandidates,
    progress,
    dump,
    lockKey,
  } = yield* prepareSqliteCommand(deps, input, target);
  let snapshotId: string | undefined;
  let recoverySnapshotId: string | undefined;
  let listedSnapshots: ReadonlyArray<SnapshotInfo> | undefined;
  let prunedSnapshotIds: ReadonlyArray<SnapshotId> | undefined;
  let retentionApplied: boolean | undefined;
  let transfer: DataTransferResult | undefined;
  let format: "sql" | "sqlite" | undefined;

  const withSqliteLock = <A, E>(body: Effect.Effect<A, E>) => sqlite.stateStore.withLock(lockKey, body);

  switch (action) {
    case "export": {
      const exported = yield* exportSqliteDump({
        sqlite,
        service,
        target,
        destination: dumpStdio?._tag === "stdout" ? dumpStdio : { _tag: "file", path: file },
        compression: exportCompression(input),
        ...(input.compressionLevel === undefined ? {} : { compressionLevel: input.compressionLevel }),
      });
      transfer = exported;
      format = exported.format;
      break;
    }
    case "import":
      transfer = yield* Effect.gen(function* () {
        const workingPath = dump?.path ?? file;
        recoverySnapshotId = yield* withSqliteLock(
          mutateSqlite(deps, sqlite, service, target, "import", (helper) =>
            prepareSqliteImportPayload(
              { sqlite, target, helper },
              { path: workingPath, digest: dump?.digest ?? "" },
            ).pipe(
              Effect.map((payload) => {
                format = payload.format;
                return payload.path;
              }),
            ),
          ),
        );
        return { accelerated: false as const, sizeBytes: hostFileSize(workingPath) };
      });
      break;
    case "reset":
      recoverySnapshotId = yield* withSqliteLock(mutateSqlite(deps, sqlite, service, target, "reset"));
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
        plan: deps.plan,
        appliedPlans: deps.appliedPlans,
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
              snapshot.metadata.path === previous.metadata?.path
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
          recoverySnapshotId = yield* mutateSqlite(
            deps,
            sqlite,
            service,
            target,
            "restore",
            (helper) =>
              Effect.gen(function* () {
                yield* requireSqliteCompatibleSnapshot(restoreSource, {
                  ownerKey: owner.ownerKey,
                  appRoot: owner.appRoot,
                  service: target.name,
                  path: target.path,
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
      return absurd<never>(action);
  }

  yield* progress.complete.pipe(
    mapFailures((cause) =>
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
    ...(format === undefined ? {} : { format }),
    ...(snapshotId === undefined ? {} : { snapshotId }),
    ...(recoverySnapshotId === undefined ? {} : { recoverySnapshotId, recoveryPath: target.path }),
    ...(recoverySnapshotId === undefined &&
    (input.action === "import" || input.action === "restore" || input.action === "reset")
      ? { recoverySkipped: "database-missing" as const }
      : {}),
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
}, Effect.scoped);

export const sqliteSidecarNames = sqliteSidecarPaths;
