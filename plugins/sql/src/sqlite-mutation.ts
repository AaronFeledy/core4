import { randomUUID } from "node:crypto";

import { mapFailures } from "@lando/sdk/command-result";
import { SqlRecoveryUnavailableError } from "@lando/sdk/errors";
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
  withSqliteHelper,
} from "./sqlite-helper.ts";
import {
  requireSqliteIntegrity,
  sqliteCompletionReceiptSql,
  sqliteIntegritySql,
} from "./sqlite-integrity.ts";
import { sqliteMutationPrelude, sqliteResetSql } from "./sqlite-mutation-control.ts";
import { sqliteRecoveryFailure } from "./sqlite-recovery-failure.ts";
import { sqliteRetentionSelection } from "./sqlite-retention.ts";
import { type SqliteSnapshotDeps, persistSqliteSnapshot, sqliteSnapshotVolume } from "./sqlite-snapshot.ts";
import { withSuspendedSqlite } from "./sqlite-suspension.ts";
import type { SqlFileTarget } from "./target.ts";
import { type SqlPlanService, sqlPlanIdentity } from "./views.ts";

const sqlString = (value: string) => `'${value.replaceAll("'", "''")}'`;

export const mutateSqlite = Effect.fn("Sql.mutateSqlite")(function* (
  deps: SqlCommandDeps,
  sqlite: SqliteSnapshotDeps,
  service: SqlPlanService,
  target: SqlFileTarget,
  operation: "reset" | "import" | "restore",
  prepare?: (helper: SqliteHelperContext) => Effect.Effect<string, unknown>,
  retainSnapshotId?: string,
) {
  const id = randomUUID();
  let captured = false;
  let catalogued = false;
  let verified = false;
  let recoveryScratch = "";
  const result = yield* withSuspendedSqlite(deps, target, (runtime) =>
    withSqliteHelper(
      { ...sqlite, inspect: () => Effect.succeed(runtime) },
      service,
      target,
      (helper) => {
        recoveryScratch = helper.scratchHost;
        return Effect.scoped(
          Effect.gen(function* () {
            // Prepare and verify the source before acquiring the database lock.
            const source = prepare === undefined ? undefined : yield* prepare(helper);
            if (!helper.existed)
              yield* runSqliteHelper(sqlite, target, helper, [
                "sh",
                "-eu",
                "-c",
                'mkdir -p "${1%/*}"; sqlite3 -bail "$1" "PRAGMA user_version=0;"',
                "sqlite-create",
                helper.dbPath,
              ]);
            const backup = sqliteScratchFile(helper, ".sqlite");
            const version = sqliteScratchFile(helper, ".version");
            const ready = sqliteScratchFile(helper, ".ready");
            const completed = sqliteScratchFile(helper, ".completed");
            const input = yield* Queue.unbounded<Uint8Array, Cause.Done>();
            yield* Effect.addFinalizer(() => Queue.end(input));
            yield* Queue.offer(
              input,
              new TextEncoder().encode(
                sqliteMutationPrelude(
                  helper.existed ? backup.target : undefined,
                  version.target,
                  ready.target,
                ),
              ),
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
            if (helper.existed) {
              yield* requireSqliteDatabaseHeader(
                backup.host,
                target.name,
                "SQLite recovery capture is invalid.",
              );
              yield* requireSqliteIntegrity(sqlite, target, helper, backup.target);
              captured = true;
              recoveryScratch = backup.host;
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
              });
              catalogued = true;
              yield* deps.publish(
                MessageInfoEvent.make({
                  body: `Recovery snapshot ${id} covers only ${target.path} on ${target.name}. Restore with lando db:restore ${id} --service ${target.name}.`,
                  timestamp: yield* DateTime.now,
                }),
              );
            }
            // The helper is still waiting for stdin with its exclusive engine lock held.
            // Shell dot-command arguments are generated scratch paths, never authored database names.
            const sql =
              source === undefined
                ? sqliteResetSql(sqliteScratchFile(helper, ".reset.sql").target)
                : `.restore ${JSON.stringify(source)}\n`;
            yield* Queue.offer(
              input,
              new TextEncoder().encode(
                `${sql}\n${sqliteIntegritySql}\n.output ${JSON.stringify(completed.target)}\n${sqliteCompletionReceiptSql(sqlString(id))}\n.output stdout\n.quit\n`,
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
            verified = true;
            return catalogued ? id : undefined;
          }),
        );
      },
      { recoveryFile: () => (captured && !catalogued ? recoveryScratch : undefined), mutation: true },
    ),
  ).pipe(
    mapFailures((cause) =>
      captured
        ? sqliteRecoveryFailure(cause, target, {
            operation,
            file: recoveryScratch,
            completed: verified,
            ...(catalogued ? { snapshotId: id } : {}),
          })
        : cause,
    ),
  );

  if (!catalogued) return result;
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
    const selection = sqliteRetentionSelection(snapshots, target.path, DEFAULT_SNAPSHOT_KEEP_LATEST, true, [
      id,
      ...(retainSnapshotId === undefined ? [] : [retainSnapshotId]),
    ]);

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
