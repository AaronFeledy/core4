import { Effect } from "effect";

import type { PreparedDump } from "./dump-file.ts";
import { isSqliteDatabaseHeader } from "./sqlite-header.ts";
import {
  type SqliteHelperContext,
  requireSqliteDatabaseHeader,
  runSqliteHelper,
  sqliteScratchFile,
} from "./sqlite-helper.ts";
import { requireSqliteIntegrity, sqliteScratchOnlyHelper } from "./sqlite-integrity.ts";
import { stageVerifiedSqliteImport } from "./sqlite-snapshot-transfer.ts";
import type { SqliteSnapshotDeps } from "./sqlite-snapshot.ts";
import type { SqlFileTarget } from "./target.ts";

export const prepareSqliteImportPayload = Effect.fn("Sql.prepareSqliteImportPayload")(function* (
  context: {
    readonly sqlite: SqliteSnapshotDeps;
    readonly target: SqlFileTarget;
    readonly helper: SqliteHelperContext;
  },
  dump: PreparedDump,
) {
  const { sqlite, target, helper } = context;
  const stagedInput = sqliteScratchFile(helper, ".input");
  yield* stageVerifiedSqliteImport(dump.path, stagedInput.host, dump.digest, target.name);
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
    return { path: stagedInput.target, format: "sqlite" as const };
  }
  const database = sqliteScratchFile(helper, ".sqlite");
  const stagingHelper = sqliteScratchOnlyHelper(helper);
  yield* runSqliteHelper(sqlite, target, stagingHelper, ["sqlite3", "-bail", database.target], {
    stdinStream: Bun.file(stagedInput.host).stream(),
  });
  yield* requireSqliteDatabaseHeader(
    database.host,
    target.name,
    "SQL import did not produce a SQLite database.",
  );
  yield* requireSqliteIntegrity(sqlite, target, helper, database.target);
  return { path: database.target, format: "sql" as const };
});
