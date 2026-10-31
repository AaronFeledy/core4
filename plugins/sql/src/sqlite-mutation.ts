import { randomUUID } from "node:crypto";

import {
  SqlCommandFailedError,
  SqlRecoveryOperationError,
  SqlRecoveryUnavailableError,
} from "@lando/sdk/errors";
import { runProbe } from "@lando/sdk/probe";
import { type Cause, DateTime, Duration, Effect, Fiber, Queue, Stream } from "effect";

import { MessageInfoEvent, MessageWarnEvent } from "@lando/sdk/events";
import { ServiceName } from "@lando/sdk/schema";
import type { SqlCommandDeps } from "./command-types.ts";
import { DEFAULT_SNAPSHOT_KEEP_LATEST } from "./snapshot-retention.ts";
import {
  type SqliteHelperContext,
  requireSqliteDatabaseHeader,
  runSqliteHelper,
  sqliteScratchFile,
  verifySqliteHelperVolume,
  withSqliteHelper,
} from "./sqlite-helper.ts";
import { requireSameSqliteTarget, resolveSqliteTargetIdentity } from "./sqlite-identity.ts";
import { requireSqliteIntegrity, sqliteIntegritySql } from "./sqlite-integrity.ts";
import { sqliteRetentionSelection } from "./sqlite-retention.ts";
import { type SqliteSnapshotDeps, persistSqliteSnapshot, sqliteSnapshotVolume } from "./sqlite-snapshot.ts";
import type { SqlFileTarget } from "./target.ts";
import { type SqlPlanService, sqlPlanIdentity } from "./views.ts";

// Shell dot-command arguments are generated scratch paths, never authored database names.
const dotPath = (path: string) => JSON.stringify(path);
const sqlString = (value: string) => `'${value.replaceAll("'", "''")}'`;

export const sqliteResetSql = (script: string): string => `
PRAGMA foreign_keys=OFF;
.output ${dotPath(script)}
SELECT 'DROP VIEW IF EXISTS main.' || '"' || replace(name, '"', '""') || '";' FROM main.sqlite_schema WHERE type='view' AND name NOT GLOB 'sqlite_*';
SELECT 'DROP TABLE IF EXISTS main.' || '"' || replace(name, '"', '""') || '";' FROM pragma_table_list() WHERE schema='main' AND type IN ('table','virtual') AND name NOT GLOB 'sqlite_*' ORDER BY type DESC;
.output stdout
BEGIN EXCLUSIVE;
.read ${dotPath(script)}
PRAGMA main.user_version=0;
CREATE TEMP TABLE lando_reset_check (remaining INTEGER CHECK (remaining=0));
INSERT INTO temp.lando_reset_check SELECT count(*) FROM main.sqlite_schema WHERE name NOT GLOB 'sqlite_*';
COMMIT;
`;

export const sqliteMutationPrelude = (backup: string, version: string, ready: string) => `
.bail on
.timeout 0
PRAGMA main.locking_mode=EXCLUSIVE;
BEGIN EXCLUSIVE;
COMMIT;
CREATE TEMP TABLE lando_journal_check (mode TEXT CHECK (mode IN ('delete','truncate','persist','wal')));
INSERT INTO temp.lando_journal_check SELECT journal_mode FROM pragma_journal_mode();
.output ${dotPath(version)}
SELECT sqlite_version();
.output stdout
.backup main ${dotPath(backup)}
.output ${dotPath(ready)}
SELECT 'ready';
.output stdout
`;

const mutationFailure = (
  cause: unknown,
  target: SqlFileTarget,
  operation: "reset" | "import" | "restore",
  id: string,
  scratch: string,
) => {
  const remediation = `Recovery ${id} covers only ${target.path} on ${target.name}. Run lando db:restore ${id} --service ${target.name} if cataloged; otherwise preserve ${scratch}, which contains the captured .sqlite payload if capture completed. Resolve the failure before retrying.`;
  return cause instanceof SqlCommandFailedError
    ? new SqlCommandFailedError({
        message: cause.message,
        service: cause.service,
        command: cause.command,
        ...(cause.exitCode === undefined ? {} : { exitCode: cause.exitCode }),
        ...(cause.reason === undefined ? {} : { reason: cause.reason }),
        ...(cause.stderrTail === undefined ? {} : { stderrTail: cause.stderrTail }),
        recoverySnapshotId: id,
        remediation: `${cause.remediation} ${remediation}`,
      })
    : new SqlRecoveryOperationError({
        message: `${operation} did not complete successfully for ${target.path} on ${target.name}. Recovery ID: ${id}.`,
        service: target.name,
        operation,
        recoverySnapshotId: id,
        cause,
        remediation,
      });
};

export const mutateSqlite = Effect.fn("Sql.mutateSqlite")(function* (
  deps: SqlCommandDeps,
  sqlite: SqliteSnapshotDeps,
  service: SqlPlanService,
  target: SqlFileTarget,
  operation: "reset" | "import" | "restore",
  prepare?: (helper: SqliteHelperContext, targetIdentity: string) => Effect.Effect<string, unknown>,
  retainSnapshotId?: string,
) {
  const id = randomUUID();
  let captured = false;
  let recoveryScratch = "";
  let capturedTargetIdentity = "";
  const result = yield* withSqliteHelper(
    sqlite,
    service,
    target,
    (helper) => {
      recoveryScratch = helper.scratchHost;
      return Effect.scoped(
        Effect.gen(function* () {
          // Prepare and verify the source before acquiring the database lock.
          const targetIdentity = yield* resolveSqliteTargetIdentity(sqlite, helper, target);
          const source = prepare === undefined ? undefined : yield* prepare(helper, targetIdentity);
          const backup = sqliteScratchFile(helper, ".sqlite");
          const version = sqliteScratchFile(helper, ".version");
          const ready = sqliteScratchFile(helper, ".ready");
          const completed = sqliteScratchFile(helper, ".completed");
          const input = yield* Queue.unbounded<Uint8Array, Cause.Done>();
          yield* Effect.addFinalizer(() => Queue.end(input));
          yield* Queue.offer(
            input,
            new TextEncoder().encode(sqliteMutationPrelude(backup.target, version.target, ready.target)),
          );
          const runner = yield* Effect.forkScoped(
            runSqliteHelper(sqlite, target, helper, ["sqlite3", "-bail", "-ifexists", helper.dbPath], {
              stdinStream: Stream.toAsyncIterable(Stream.fromQueue(input)),
            }),
          );
          const waiting = runProbe(
            {
              id: `sqlite-capture:${target.name}`,
              policy: { maxAttempts: 600, delay: Duration.millis(50), timeout: Duration.seconds(30) },
              classify: { success: (exists) => (exists === true ? "green" : "red"), failure: () => "red" },
            },
            Effect.promise(() => Bun.file(ready.host).exists()),
          ).pipe(
            Effect.flatMap((probe) =>
              probe.outcome === "green"
                ? Effect.void
                : Effect.fail(
                    new SqlRecoveryUnavailableError({
                      message: `Cannot establish exclusive SQLite recovery for ${target.name}.`,
                      service: target.name,
                      reason:
                        "The helper did not finish lock acquisition and recovery capture before the deadline.",
                      remediation:
                        "Close SQLite clients and check helper permissions and disk space, then retry. --yes and --force cannot bypass this check.",
                    }),
                  ),
            ),
          );
          yield* Effect.raceFirst(
            waiting,
            Fiber.join(runner).pipe(
              Effect.flatMap(() =>
                Effect.fail(
                  new SqlRecoveryUnavailableError({
                    message: "SQLite helper exited before recovery was ready.",
                    service: target.name,
                    reason: "No recovery handshake was received.",
                    remediation: "Inspect the helper error and retry.",
                  }),
                ),
              ),
            ),
          );
          yield* requireSqliteDatabaseHeader(backup.host, target.name, "SQLite recovery capture is invalid.");
          yield* verifySqliteHelperVolume(sqlite, target, helper);
          yield* requireSameSqliteTarget(
            targetIdentity,
            yield* resolveSqliteTargetIdentity(sqlite, helper, target),
            target.name,
          );
          yield* requireSqliteIntegrity(sqlite, target, helper, backup.target);
          captured = true;
          capturedTargetIdentity = targetIdentity;
          const engineVersion = yield* Effect.tryPromise({
            try: () => Bun.file(version.host).text(),
            catch: (cause) =>
              new SqlRecoveryUnavailableError({
                message: "Cannot read SQLite version.",
                service: target.name,
                reason: String(cause),
                remediation: "Check snapshot scratch permissions.",
              }),
          });
          yield* persistSqliteSnapshot(sqlite, deps.plan, target, backup.host, engineVersion.trim(), {
            id,
            recoveryReason: operation,
            targetIdentity,
          });
          yield* deps.publish(
            MessageInfoEvent.make({
              body: `Recovery snapshot ${id} covers only ${target.path} on ${target.name}. Restore with lando db:restore ${id} --service ${target.name}.`,
              timestamp: yield* DateTime.now,
            }),
          );
          yield* verifySqliteHelperVolume(sqlite, target, helper);
          yield* requireSameSqliteTarget(
            targetIdentity,
            yield* resolveSqliteTargetIdentity(sqlite, helper, target),
            target.name,
          );
          // The helper is still waiting for stdin with its exclusive engine lock held.
          const sql =
            source === undefined
              ? sqliteResetSql(sqliteScratchFile(helper, ".reset.sql").target)
              : `.restore ${dotPath(source)}\n`;
          yield* Queue.offer(
            input,
            new TextEncoder().encode(
              `${sql}\n${sqliteIntegritySql}\n.output ${dotPath(completed.target)}\nSELECT ${sqlString(id)};\n.output stdout\n.quit\n`,
            ),
          );
          yield* Queue.end(input);
          yield* Fiber.join(runner);
          const receipt = yield* Effect.tryPromise({
            try: () => Bun.file(completed.host).text(),
            catch: (cause) =>
              new SqlRecoveryUnavailableError({
                message: "Cannot verify SQLite mutation completion.",
                service: target.name,
                reason: String(cause),
                remediation: "Check database state before retrying.",
              }),
          });
          if (receipt.trim() !== id)
            return yield* Effect.fail(
              new SqlRecoveryUnavailableError({
                message: "SQLite mutation did not produce its completion receipt.",
                service: target.name,
                reason: "The helper did not acknowledge the final SQL statements.",
                remediation: "Check database state before retrying.",
              }),
            );
          return id;
        }),
      );
    },
    { preserveOnFailure: true },
  ).pipe(
    Effect.mapError((cause) =>
      captured ? mutationFailure(cause, target, operation, id, recoveryScratch) : cause,
    ),
  );

  const owner = sqlPlanIdentity(deps.plan);
  const store = sqliteSnapshotVolume(deps.plan, target.path);
  const filter = {
    app: store.app,
    store: store.store,
    ownerKey: owner.ownerKey,
    service: ServiceName.make(target.name),
  };
  yield* Effect.gen(function* () {
    const snapshots = yield* deps.listSnapshots(filter);
    if (!snapshots.some((snapshot) => snapshot.id === id))
      return yield* Effect.fail(
        new SqlRecoveryUnavailableError({
          message: "Recovery retention cannot locate the newly captured snapshot.",
          service: target.name,
          reason: `The snapshot catalog did not return ${id}.`,
          remediation: "Preserve the recovery files and inspect the snapshot catalog before pruning.",
        }),
      );
    const selection = sqliteRetentionSelection(
      snapshots,
      capturedTargetIdentity,
      DEFAULT_SNAPSHOT_KEEP_LATEST,
      true,
      [id, ...(retainSnapshotId === undefined ? [] : [retainSnapshotId])],
    );

    yield* deps.pruneSnapshots({
      filter,
      recovery: true,
      keepLatest: selection.keepLatest,
      retainSnapshotIds: selection.retainSnapshotIds,
    });
  }).pipe(
    Effect.catch(() =>
      deps
        .publish(
          MessageWarnEvent.make({
            body: `SQLite ${operation} completed. Recovery snapshot ${id} remains available, but older recovery snapshots could not be pruned.`,
            timestamp: DateTime.nowUnsafe(),
          }),
        )
        .pipe(Effect.catch(() => Effect.logWarning("Could not publish SQLite recovery retention warning."))),
    ),
  );

  return result;
});
