import { mkdir, mkdtemp, rm } from "node:fs/promises";
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
