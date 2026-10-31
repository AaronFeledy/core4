import { SqlRecoveryUnavailableError } from "@lando/sdk/errors";
import { Effect } from "effect";

import { type SqliteHelperContext, type SqliteHelperDeps, runSqliteHelper } from "./sqlite-helper.ts";
import type { SqlFileTarget } from "./target.ts";

/** Run on the mutation connection before it can acknowledge successful completion. */
export const sqliteIntegritySql = `
CREATE TEMP TABLE lando_integrity_result (result TEXT CHECK (result='ok'));
INSERT INTO temp.lando_integrity_result SELECT integrity_check FROM pragma_integrity_check();
CREATE TEMP TABLE lando_integrity_count (count INTEGER CHECK (count=1));
INSERT INTO temp.lando_integrity_count SELECT count(*) FROM temp.lando_integrity_result;
`;

/** SQL loaders and validators must not receive the live database's mounts. */
export const sqliteScratchOnlyHelper = (helper: SqliteHelperContext): SqliteHelperContext => ({
  ...helper,
  spec: {
    image: helper.spec.image,
    binds: [{ source: helper.scratchHost, target: helper.scratchTarget }],
    user: helper.user,
    entrypoint: [],
    remove: true,
  },
});

export const requireSqliteIntegrity = Effect.fn("Sql.requireSqliteIntegrity")(function* (
  deps: SqliteHelperDeps,
  target: SqlFileTarget,
  helper: SqliteHelperContext,
  stagedPath: string,
) {
  const result = yield* runSqliteHelper(
    deps,
    target,
    sqliteScratchOnlyHelper(helper),
    ["sqlite3", "-bail", "-readonly", "-ifexists", stagedPath, "PRAGMA main.integrity_check;"],
    { captureStdout: true },
  );
  if (result.stdout.trim() !== "ok") {
    return yield* Effect.fail(
      new SqlRecoveryUnavailableError({
        message: `SQLite integrity validation failed for ${target.name}.`,
        service: target.name,
        reason: "The staged database did not return exactly one successful integrity_check result.",
        remediation:
          "Use an intact SQLite database or repair and validate the source before retrying. The target has not been changed.",
      }),
    );
  }
});
