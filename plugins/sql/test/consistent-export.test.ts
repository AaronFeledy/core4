import { afterEach, expect, test } from "bun:test";
import { Effect } from "effect";

import { executeDbCommand } from "../src/execute.ts";
import { dumpCommand } from "../src/families.ts";
import { cleanupSqlTestDeps, makeSqlTestDeps } from "./support/fakes.ts";

afterEach(cleanupSqlTestDeps);

for (const family of ["mysql", "mariadb"] as const) {
  test(`requests a consistent streaming export when using ${family}`, async () => {
    // Given: a configured transactional database.
    const harness = makeSqlTestDeps({ password: "secret", type: `${family}:8.0` });
    // When: a logical export is requested.
    await Effect.runPromise(
      executeDbCommand(harness.deps, { action: "export", file: "dump.sql", yes: false }),
    );
    // Then: the service command uses a consistent read without client-side row buffering.
    const source = harness.transfers()[0]?.from;
    expect(source?._tag).toBe("serviceCmd");
    if (source?._tag === "serviceCmd") {
      expect(source.command).toContain("--single-transaction");
      expect(source.command).toContain("--quick");
      expect(source.command).toContain("--no-tablespaces");
      expect(source.command.includes("--set-gtid-purged=OFF")).toBe(family === "mysql");
    }
  });
}

test("omits MySQL-only GTID flags when building a MariaDB export", () => {
  // Given: a MariaDB target and explicit credentials.
  const creds = { user: "alice", database: "appdb" };
  // When: the export command is built.
  const command = dumpCommand("mariadb", creds);
  // Then: MariaDB receives its own supported command-line contract.
  expect(command).toEqual([
    "mariadb-dump",
    "-u",
    "alice",
    "--single-transaction",
    "--quick",
    "--no-tablespaces",
    "appdb",
  ]);
});
