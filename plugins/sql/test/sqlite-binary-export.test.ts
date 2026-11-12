import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { link, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SqlRecoveryUnavailableError } from "@lando/sdk/errors";
import { Effect, Result } from "effect";
import { executeDbCommand } from "../src/run.ts";
import { sqliteExportFormat } from "../src/sqlite-dump.ts";
import { executeSqliteCommand } from "../src/sqlite-execute.ts";
import { cleanupSqlTestDeps } from "./support/fakes.ts";
import { sqlitePayloadFixture } from "./support/sqlite-payload.ts";

afterEach(cleanupSqlTestDeps);

test.each([
  ["copy.sqlite", "sqlite"],
  ["copy.sqlite3", "sqlite"],
  ["copy.db", "sqlite"],
  ["copy.db3", "sqlite"],
  ["copy.db.gz", "sqlite"],
  ["copy.sqlite3.zst", "sqlite"],
  ["COPY.SQLITE3.ZST", "sqlite"],
  ["COPY.DB", "sqlite"],
  ["dump.sql", "sql"],
  ["dump.sql.gz", "sql"],
  ["-", "sql"],
  ["copy.sqlite.sql", "sql"],
] as const)("selects %s payload as %s", (path, format) => {
  expect(sqliteExportFormat(path)).toBe(format);
});

test.each(["copy.sqlite", "copy.db.gz", "copy.sqlite3.zst", "COPY.DB.GZ", "COPY.SQLITE3.ZST"])(
  "exports verified binary SQLite to %s atomically",
  async (name) => {
    const f = await sqlitePayloadFixture();
    const file = join(f.root, name);
    await writeFile(file, "old export");
    const before = await stat(file);
    const result = await Effect.runPromise(
      executeDbCommand(f.deps, {
        action: "export",
        file,
        yes: false,
        ...(name.toLowerCase().endsWith(".gz") || name.toLowerCase().endsWith(".zst")
          ? { compressionLevel: 1 }
          : {}),
      }),
    );
    const bytes = new Uint8Array(await Bun.file(file).arrayBuffer());
    const plain = name.toLowerCase().endsWith(".gz")
      ? Bun.gunzipSync(bytes)
      : name.toLowerCase().endsWith(".zst")
        ? Bun.zstdDecompressSync(bytes)
        : bytes;
    using database = Database.deserialize(plain);
    expect(database.query("SELECT rowid,name FROM items ORDER BY rowid").values()).toEqual([
      [42, "first"],
      [900, "last"],
    ]);
    expect((await stat(file)).ino).not.toBe(before.ino);
    expect(result).toMatchObject({ format: "sqlite", sizeBytes: bytes.byteLength });
    const backup = f.commands.find((command) => command.at(-1)?.startsWith(".backup main "));
    expect(backup?.slice(0, 6)).toEqual([
      "sqlite3",
      "-bail",
      "-readonly",
      "-ifexists",
      "/app/data/site.sqlite",
      ".timeout 5000",
    ]);
    expect(f.commands.some((command) => command.at(-1) === "PRAGMA main.integrity_check;")).toBe(true);
    expect(f.commands.some((command) => command.join(" ").includes(".dump"))).toBe(false);
  },
);

test.each([false, true])(
  "integrity failure leaves binary destination untouched (existing=%s)",
  async (existing) => {
    const f = await sqlitePayloadFixture({ integrity: "corrupt\n" });
    const file = join(f.root, "copy.sqlite");
    if (existing) await writeFile(file, "old export");
    const result = await Effect.runPromise(
      Effect.result(executeSqliteCommand(f.deps, { action: "export", file, yes: false }, f.target)),
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) expect(result.failure).toBeInstanceOf(SqlRecoveryUnavailableError);
    if (existing) expect(await Bun.file(file).text()).toBe("old export");
    else expect(await Bun.file(file).exists()).toBe(false);
  },
);

test("binary export refuses a hardlink to the live database before capture", async () => {
  const f = await sqlitePayloadFixture();
  const file = join(f.root, "alias.db");
  await link(f.databasePath, file);
  const result = await Effect.runPromise(
    Effect.result(executeSqliteCommand(f.deps, { action: "export", file, yes: false }, f.target)),
  );
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result))
    expect(result.failure).toMatchObject({
      _tag: "SqlRecoveryUnavailableError",
      message: expect.stringContaining("aliases SQLite database"),
    });
  expect(new Uint8Array(await Bun.file(f.databasePath).arrayBuffer())).toEqual(f.bytes);
  expect(f.commands).toEqual([]);
});
