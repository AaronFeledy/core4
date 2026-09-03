import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";

import { SqlDumpNotFoundError } from "@lando/sdk/errors";

import { ensureReadableDump } from "../src/dump-file.ts";

describe("ensureReadableDump", () => {
  let appRoot = "";

  beforeEach(async () => {
    appRoot = await mkdtemp(join(tmpdir(), "lando-sql-dump-"));
  });

  afterEach(async () => {
    await rm(appRoot, { recursive: true, force: true });
  });

  test("fails with SqlDumpNotFoundError when the dump file is missing", async () => {
    const path = join(appRoot, "missing.sql.gz");
    const exit = await Effect.runPromiseExit(ensureReadableDump(path, appRoot));

    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) throw new Error("expected failure");
    const error = exit.cause._tag === "Fail" ? exit.cause.error : undefined;
    expect(error).toBeInstanceOf(SqlDumpNotFoundError);
    if (!(error instanceof SqlDumpNotFoundError)) return;
    expect(error.path).toBe(path);
    expect(error.appRoot).toBe(appRoot);
    expect(error.message).toContain("Dump file not found");
  });

  test("passes for a readable dump file", async () => {
    const path = join(appRoot, "ok.sql.gz");
    await writeFile(path, "x");
    const exit = await Effect.runPromiseExit(ensureReadableDump(path, appRoot));

    expect(Exit.isSuccess(exit)).toBe(true);
  });

  test("fails with SqlDumpNotFoundError when the dump file exists but is not readable", async () => {
    // root bypasses mode bits, so the permission miss cannot be provoked there.
    if (process.getuid?.() === 0 || process.platform === "win32") return;
    const path = join(appRoot, "locked.sql.gz");
    await writeFile(path, "x");
    await chmod(path, 0o000);
    const exit = await Effect.runPromiseExit(ensureReadableDump(path, appRoot));

    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) throw new Error("expected failure");
    const error = exit.cause._tag === "Fail" ? exit.cause.error : undefined;
    expect(error).toBeInstanceOf(SqlDumpNotFoundError);
    if (!(error instanceof SqlDumpNotFoundError)) return;
    expect(error.path).toBe(path);
    expect(error.message).toContain("not readable");
  });

  test("fails with SqlDumpNotFoundError when the dump path is a directory", async () => {
    const path = join(appRoot, "dump-dir");
    await mkdir(path);
    const exit = await Effect.runPromiseExit(ensureReadableDump(path, appRoot));

    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) throw new Error("expected failure");
    const error = exit.cause._tag === "Fail" ? exit.cause.error : undefined;
    expect(error).toBeInstanceOf(SqlDumpNotFoundError);
    if (!(error instanceof SqlDumpNotFoundError)) return;
    expect(error.path).toBe(path);
    expect(error.message).toContain("directory");
  });
});
