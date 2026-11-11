import { afterEach, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { encodeCommandResult, identityRedactor } from "@lando/sdk/command-result";
import { Effect } from "effect";
import { executeDbCommand } from "../src/run.ts";
import { DbCommandResult } from "../src/schemas.ts";
import { executeSqliteCommand } from "../src/sqlite-execute.ts";
import { cleanupSqlTestDeps, makeSqlTestDeps } from "./support/fakes.ts";
import { sqlitePayloadFixture } from "./support/sqlite-payload.ts";

afterEach(cleanupSqlTestDeps);

test.each(["copy.sqlite", "copy.db", "copy.db.gz", "copy.sqlite3.zst", "binary-without-suffix", "text.db"])(
  "imports %s by content and reports its format in machine output",
  async (name) => {
    const f = await sqlitePayloadFixture({ exists: false });
    const file = join(f.root, name);
    await writeFile(
      file,
      name === "text.db"
        ? "CREATE TABLE items(name TEXT);"
        : name.endsWith(".gz")
          ? Bun.gzipSync(f.bytes)
          : name.endsWith(".zst")
            ? Bun.zstdCompressSync(f.bytes)
            : f.bytes,
    );
    const result = await Effect.runPromise(
      executeSqliteCommand(f.deps, { action: "import", file, yes: true }, f.target),
    );
    const encoded = await Effect.runPromise(
      encodeCommandResult({
        command: "db:import",
        resultSchema: DbCommandResult,
        outcome: { _tag: "success", value: result },
        redactor: identityRedactor,
      }),
    );
    expect(JSON.parse(encoded)).toMatchObject({
      ok: true,
      result: { family: "sqlite", format: name === "text.db" ? "sql" : "sqlite" },
    });
    expect(f.commands.some((command) => command.at(-1) === "PRAGMA main.integrity_check;")).toBe(true);
  },
);

test.each(["copy.sqlite", "dump.sql", "-"])(
  "reports the SQLite export format for %s in machine output",
  async (name) => {
    const f = await sqlitePayloadFixture();
    const file = name === "-" ? name : join(f.root, name);
    const result = await Effect.runPromise(
      executeSqliteCommand(
        f.deps,
        { action: "export", file, yes: false, stdio: { stdout: () => Effect.void } },
        f.target,
      ),
    );
    const encoded = await Effect.runPromise(
      encodeCommandResult({
        command: "db:export",
        resultSchema: DbCommandResult,
        outcome: { _tag: "success", value: result },
        redactor: identityRedactor,
      }),
    );
    expect(JSON.parse(encoded)).toMatchObject({
      ok: true,
      result: { format: name === "copy.sqlite" ? "sqlite" : "sql" },
    });
  },
);

test("server export keeps SQL behavior and omits payload format for a database suffix", async () => {
  const f = makeSqlTestDeps({ password: "secret" });
  const result = await Effect.runPromise(
    Effect.scoped(executeDbCommand(f.deps, { action: "export", file: "copy.sqlite", yes: false })),
  );
  expect(result).not.toHaveProperty("format");
  expect(f.transfers()).toHaveLength(1);
});
