import { expect, test } from "bun:test";
import { SqlCommandFailedError, VolumeOperationError } from "@lando/sdk/errors";
import { AbsolutePath } from "@lando/sdk/schema";
import { Effect } from "effect";
import { checkedSqliteHelper } from "../src/sqlite-helper-run.ts";

for (const providerFailure of [false, true]) {
  test(`SQLite ${providerFailure ? "provider" : "command"} diagnostics omit SQL excerpts`, async () => {
    const stderr =
      "Parse error near line 10: table sqlite_master may not be modified\n  INSERT INTO sqlite_schema VALUES('secret');\n  ^--- error here\nRuntime error near line 12: database is locked (5)";
    const error = await Effect.runPromise(
      checkedSqliteHelper(
        {
          applied: { root: AbsolutePath.make("/app") },
          inspect: () => Effect.succeed({ status: "running", running: true }),
          paths: { ownerSnapshotsDir: () => "/unused" },
          privateFileAccess: { enforce: async () => undefined, verify: async () => undefined },
          pullArtifact: () => Effect.succeed({}),
          run: () =>
            providerFailure
              ? Effect.fail(
                  new VolumeOperationError({
                    providerId: "test",
                    operation: "run",
                    message: "Failed",
                    remediation: "Retry",
                    details: { exitCode: 1, stderrTail: stderr },
                  }),
                )
              : Effect.succeed({ exitCode: 1, stdout: "", stderr }),
        },
        { kind: "file", family: "sqlite", type: "php", name: "appserver", path: "db.sqlite" },
        { image: "sqlite", command: ["sqlite3"] },
      ).pipe(Effect.flip),
    );
    expect(error).toBeInstanceOf(SqlCommandFailedError);
    expect(error.exitCode).toBe(1);
    expect(error.stderrTail).toBe(
      "Parse error near line 10: table sqlite_master may not be modified\nRuntime error near line 12: database is locked (5)",
    );
  });
}
