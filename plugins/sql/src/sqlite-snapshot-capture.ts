import { SqlRecoveryUnavailableError } from "@lando/sdk/errors";
import type { SnapshotMetadata } from "@lando/sdk/schema";
import { Effect } from "effect";

import {
  type SqliteHelperContext,
  type SqliteHelperDeps,
  requireSqliteDatabaseHeader,
  runSqliteHelper,
  sqliteScratchFile,
  withSqliteHelper,
} from "./sqlite-helper.ts";
import { requireSqliteIntegrity } from "./sqlite-integrity.ts";
import { type SqliteSnapshotDeps, persistSqliteSnapshot } from "./sqlite-snapshot.ts";
import type { SqlFileTarget } from "./target.ts";
import type { SqlPlan, SqlPlanService } from "./views.ts";

const observeSqliteVersion = Effect.fn("Sql.observeSqliteVersion")(function* (
  deps: SqliteHelperDeps,
  target: SqlFileTarget,
  helper: SqliteHelperContext,
) {
  const result = yield* runSqliteHelper(
    deps,
    target,
    helper,
    ["sqlite3", "-readonly", "-ifexists", helper.dbPath, "SELECT sqlite_version();"],
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

export const captureSqliteDatabase = Effect.fn("Sql.captureSqliteDatabase")(function* (
  deps: SqliteHelperDeps,
  target: SqlFileTarget,
  helper: SqliteHelperContext,
) {
  const staged = sqliteScratchFile(helper, ".sqlite");
  yield* runSqliteHelper(deps, target, helper, [
    "sqlite3",
    "-bail",
    "-readonly",
    "-ifexists",
    helper.dbPath,
    ".timeout 5000",
    `.backup main ${JSON.stringify(staged.target)}`,
  ]);
  yield* requireSqliteDatabaseHeader(
    staged.host,
    target.name,
    `Backup did not produce a SQLite database for ${target.name}.`,
  );
  yield* requireSqliteIntegrity(deps, target, helper, staged.target);
  return staged;
});

export const createSqliteSnapshot = Effect.fn("Sql.createSqliteSnapshot")(function* (
  deps: SqliteSnapshotDeps,
  plan: SqlPlan,
  service: SqlPlanService,
  target: SqlFileTarget,
  options?: {
    readonly label?: string;
    readonly recoveryReason?: Exclude<SnapshotMetadata["recoveryReason"], "seed">;
  },
) {
  return yield* withSqliteHelper(deps, service, target, (helper) =>
    Effect.gen(function* () {
      const version = yield* observeSqliteVersion(deps, target, helper);
      const staged = yield* captureSqliteDatabase(deps, target, helper);
      return yield* persistSqliteSnapshot(deps, plan, target, staged.host, version, {
        ...options,
      });
    }),
  );
});
