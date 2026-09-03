import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect, Exit } from "effect";

import {
  SqlCommandFailedError,
  SqlConfirmRequiredError,
  SqlDumpNotFoundError,
  SqlServiceAmbiguousError,
  VolumeNotFoundError,
} from "@lando/sdk/errors";

import { wrapExportCommand, wrapImportCommand } from "../src/gzip.ts";
import { executeDbCommand } from "../src/run.ts";
import { FakeRestoreError, cleanupSqlTestDeps, makeSqlTestDeps } from "./support/fakes.ts";

const SECRET = "s3cret-pass";

afterEach(cleanupSqlTestDeps);

const run = (
  deps: ReturnType<typeof makeSqlTestDeps>["deps"],
  input: Parameters<typeof executeDbCommand>[1],
) => Effect.runPromiseExit(Effect.scoped(executeDbCommand(deps, input)));

describe("executeDbCommand", () => {
  test("exports a single mysql service without --service via serviceCmd to hostPath", async () => {
    const harness = makeSqlTestDeps({ password: SECRET });

    const exit = await run(harness.deps, { action: "export", yes: false });

    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isFailure(exit)) throw new Error("expected success");
    expect(exit.value.service).toBe("database");
    expect(exit.value.family).toBe("mysql");
    expect(exit.value.file).toBe(join(harness.root, "database.sql.gz"));
    expect(exit.value.steps.length).toBeGreaterThan(0);
    expect(exit.value.redactionTokens).toContain(SECRET);
    expect(harness.published()).toEqual([
      "task.tree.start",
      "task.start",
      "task.complete",
      "task.tree.complete",
    ]);

    const transfer = harness.transfers()[0];
    expect(transfer?.from._tag).toBe("serviceCmd");
    expect(transfer?.to._tag).toBe("hostPath");
    if (transfer?.from._tag === "serviceCmd") {
      expect(transfer.from.command).toEqual(wrapExportCommand(["mysqldump", "-u", "lando", "sql-app"], true));
      expect(transfer.from.env?.MYSQL_PWD).toBe(SECRET);
      expect(JSON.stringify(transfer.from.command)).not.toContain(SECRET);
    }
  });

  test("exports postgres through serviceCmd with gzip wrap", async () => {
    const harness = makeSqlTestDeps({
      password: SECRET,
      type: "postgres:16",
      environment: { POSTGRES_USER: "lando", POSTGRES_PASSWORD: SECRET, POSTGRES_DB: "sql-app" },
    });

    const exit = await run(harness.deps, { action: "export", yes: false });

    expect(Exit.isSuccess(exit)).toBe(true);
    const transfer = harness.transfers()[0];
    expect(transfer?.from._tag).toBe("serviceCmd");
    if (transfer?.from._tag === "serviceCmd") {
      expect(transfer.from.command).toEqual(
        wrapExportCommand(["pg_dump", "-U", "lando", "-d", "sql-app"], true),
      );
      expect(transfer.from.env?.PGPASSWORD).toBe(SECRET);
    }
  });

  test("exports mongodb through serviceCmd with gzip wrap", async () => {
    const harness = makeSqlTestDeps({
      password: SECRET,
      type: "mongodb:7",
      environment: {
        MONGO_INITDB_ROOT_USERNAME: "lando",
        MONGO_INITDB_ROOT_PASSWORD: SECRET,
        MONGO_INITDB_DATABASE: "sql-app",
      },
    });

    const exit = await run(harness.deps, { action: "export", yes: false });

    expect(Exit.isSuccess(exit)).toBe(true);
    const transfer = harness.transfers()[0];
    expect(transfer?.from._tag).toBe("serviceCmd");
    if (transfer?.from._tag === "serviceCmd") {
      const command = transfer.from.command;
      expect(Array.isArray(command)).toBe(true);
      if (!Array.isArray(command)) throw new Error("expected argv command");
      expect(command[0]).toBe("sh");
      expect(command.join(" ")).toContain("mongodump --archive");
      expect(command.join(" ")).toContain("| gzip");
      expect(transfer.from.env?.MONGO_URI).toContain(SECRET);
      expect(JSON.stringify(command)).not.toContain(SECRET);
    }
  });

  test("exports mssql by backing up in-service then transferring the bak", async () => {
    const harness = makeSqlTestDeps({
      password: SECRET,
      type: "mssql:2022",
      environment: { SA_PASSWORD: SECRET },
    });

    const exit = await run(harness.deps, { action: "export", file: "dump.bak", yes: false });

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(harness.execs()[0]?.command[0]).toBe("sqlcmd");
    const transfer = harness.transfers()[0];
    expect(transfer?.from._tag).toBe("servicePath");
    expect(transfer?.to._tag).toBe("hostPath");
  });

  test("imports mssql by transferring the bak then restoring in-service", async () => {
    const harness = makeSqlTestDeps({
      password: SECRET,
      type: "mssql:2022",
      environment: { SA_PASSWORD: SECRET },
      countStdout: "0",
    });

    const exit = await run(harness.deps, { action: "import", file: "dump.bak", yes: false });

    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isFailure(exit)) throw new Error("expected success");
    const transfer = harness.transfers()[0];
    expect(transfer?.from._tag).toBe("hostPath");
    expect(transfer?.to._tag).toBe("servicePath");
    expect(harness.execs()[0]?.command[0]).toBe("sqlcmd");
    expect(exit.value.sizeBytes).toBe(12);
  });

  test("fails closed with available services when more than one SQL target exists", async () => {
    const harness = makeSqlTestDeps({
      password: SECRET,
      extraServices: [{ name: "analytics", type: "postgres:16" }],
    });

    const exit = await run(harness.deps, { action: "export", yes: false });

    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) throw new Error("expected failure");
    const error = exit.cause._tag === "Fail" ? exit.cause.error : undefined;
    expect(error).toBeInstanceOf(SqlServiceAmbiguousError);
    if (error instanceof SqlServiceAmbiguousError) {
      expect(error.available).toEqual(["analytics", "database"]);
    }
    expect(harness.transfers()).toEqual([]);
  });

  test("fails closed when the import dump file is missing, before the count probe", async () => {
    const harness = makeSqlTestDeps({ password: SECRET });

    const exit = await run(harness.deps, { action: "import", file: "_backups/missing.sql.gz", yes: false });

    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) throw new Error("expected failure");
    const error = exit.cause._tag === "Fail" ? exit.cause.error : undefined;
    expect(error).toBeInstanceOf(SqlDumpNotFoundError);
    if (error instanceof SqlDumpNotFoundError) {
      expect(error.path).toBe(join(harness.root, "_backups/missing.sql.gz"));
      expect(error.appRoot).toBe(harness.root);
      expect(error.message).toContain("Dump file not found");
    }
    expect(harness.transfers()).toEqual([]);
    expect(harness.published()).toEqual([]);
    expect(harness.execs()).toEqual([]);
  });

  test("requires confirmation before importing into a non-empty database", async () => {
    const harness = makeSqlTestDeps({ password: SECRET, countStdout: "3" });

    const exit = await run(harness.deps, { action: "import", file: "dump.sql.gz", yes: false });

    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) throw new Error("expected failure");
    const error = exit.cause._tag === "Fail" ? exit.cause.error : undefined;
    expect(error).toBeInstanceOf(SqlConfirmRequiredError);
    if (error instanceof SqlConfirmRequiredError) {
      expect(error.service).toBe("database");
      expect(error.steps.some((step) => step.destructive)).toBe(true);
    }
    expect(harness.transfers()).toEqual([]);
    expect(harness.published()).toEqual([]);
  });

  test("resolves a relative import dump from hostCwd when it is inside the app root", async () => {
    const harness = makeSqlTestDeps({ password: SECRET, countStdout: "0" });
    const nested = join(harness.root, "backups");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "nested.sql.gz"), "x");

    const exit = await run(harness.deps, {
      action: "import",
      file: "nested.sql.gz",
      yes: false,
      hostCwd: nested,
    });

    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isFailure(exit)) throw new Error("expected success");
    expect(exit.value.file).toBe(join(nested, "nested.sql.gz"));
  });

  test("imports an empty database without confirmation", async () => {
    const harness = makeSqlTestDeps({ password: SECRET, countStdout: "0" });

    const exit = await run(harness.deps, { action: "import", file: "dump.sql.gz", yes: false });

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(harness.transfers()).toHaveLength(1);
  });

  test("imports with --yes even when the database is non-empty", async () => {
    const harness = makeSqlTestDeps({ password: SECRET, countStdout: "3" });

    const exit = await run(harness.deps, { action: "import", file: "dump.sql.gz", yes: true });

    expect(Exit.isSuccess(exit)).toBe(true);
    const transfer = harness.transfers()[0];
    expect(transfer?.from._tag).toBe("hostPath");
    expect(transfer?.to._tag).toBe("serviceCmd");
    if (transfer?.to._tag === "serviceCmd") {
      expect(transfer.to.command).toEqual(wrapImportCommand(["mysql", "-u", "lando", "sql-app"], true));
    }
  });

  test("treats a failed count probe as non-empty and requires confirmation", async () => {
    const harness = makeSqlTestDeps({ password: SECRET, countFails: true });

    const exit = await run(harness.deps, { action: "import", file: "dump.sql", yes: false });

    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) throw new Error("expected failure");
    expect(exit.cause._tag === "Fail" ? exit.cause.error : undefined).toBeInstanceOf(SqlConfirmRequiredError);
    expect(harness.transfers()).toEqual([]);
  });

  test("resets only after --yes and never puts the password on argv", async () => {
    const harness = makeSqlTestDeps({ password: SECRET });

    const denied = await run(harness.deps, { action: "reset", yes: false });
    expect(denied._tag).toBe("Failure");
    expect(harness.execs()).toEqual([]);

    const allowed = await run(harness.deps, { action: "reset", yes: true });
    expect(Exit.isSuccess(allowed)).toBe(true);
    const exec = harness.execs()[0];
    expect(exec?.command[0]).toBe("mysql");
    expect(exec?.env?.MYSQL_PWD).toBe(SECRET);
    expect(exec?.command.join(" ")).not.toContain(SECRET);
  });

  test("does not start the task tree before a denied reset", async () => {
    const harness = makeSqlTestDeps({ password: SECRET });

    const exit = await run(harness.deps, { action: "reset", yes: false });

    expect(exit._tag).toBe("Failure");
    expect(harness.execs()).toEqual([]);
    expect(harness.published()).toEqual([]);
  });

  test("fails closed when reset exec returns a non-zero exit", async () => {
    const harness = makeSqlTestDeps({ password: SECRET, execFails: true });

    const exit = await run(harness.deps, { action: "reset", yes: true });

    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) throw new Error("expected failure");
    expect(exit.cause._tag === "Fail" ? exit.cause.error : undefined).toBeInstanceOf(SqlCommandFailedError);
  });

  test("fails closed when an mssql backup exec returns a non-zero exit", async () => {
    const harness = makeSqlTestDeps({ password: SECRET, type: "mssql:2022", execFails: true });

    const exit = await run(harness.deps, { action: "export", yes: false });

    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) throw new Error("expected failure");
    expect(exit.cause._tag === "Fail" ? exit.cause.error : undefined).toBeInstanceOf(SqlCommandFailedError);
    expect(harness.transfers()).toEqual([]);
  });

  test("requests a volume snapshot with tar.gz format and optional label", async () => {
    const harness = makeSqlTestDeps({ password: SECRET });

    const exit = await run(harness.deps, { action: "snapshot", label: "before-change", yes: false });

    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isFailure(exit)) throw new Error("expected success");
    expect(exit.value.snapshotId).toBe("before-change");
    expect(harness.snapshots()[0]?.store).toBe("sql-app_database_data");
    expect(harness.snapshots()[0]?.format).toBe("tar.gz");
  });

  test("fails restore when the service has no data volume", async () => {
    const harness = makeSqlTestDeps({ password: SECRET, storage: [] });

    const exit = await run(harness.deps, { action: "restore", snapshotId: "missing", yes: false });

    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) throw new Error("expected failure");
    expect(exit.cause._tag === "Fail" ? exit.cause.error : undefined).toBeInstanceOf(VolumeNotFoundError);
    expect(harness.lifecycle()).toEqual([]);
  });

  test("restores a snapshot by stopping, restoring, then starting the service", async () => {
    const harness = makeSqlTestDeps({ password: SECRET });

    const exit = await run(harness.deps, { action: "restore", snapshotId: "before-change", yes: false });

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(harness.lifecycle()).toEqual(["stop", "restore", "start"]);
  });

  test("starts the service after a failed restore", async () => {
    const harness = makeSqlTestDeps({ password: SECRET, restoreFails: true });

    const exit = await run(harness.deps, { action: "restore", snapshotId: "before-change", yes: false });

    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) throw new Error("expected failure");
    expect(exit.cause._tag === "Fail" ? exit.cause.error : undefined).toBeInstanceOf(FakeRestoreError);
    expect(harness.lifecycle()).toEqual(["stop", "restore", "start"]);
  });

  test("starts the service after a failed restore even when start then fails", async () => {
    const harness = makeSqlTestDeps({ password: SECRET, restoreFails: true, startFails: true });

    const exit = await run(harness.deps, { action: "restore", snapshotId: "before-change", yes: false });

    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) throw new Error("expected failure");
    expect(exit.cause._tag === "Fail" ? exit.cause.error : undefined).toBeInstanceOf(FakeRestoreError);
    expect(harness.lifecycle()).toEqual(["stop", "restore", "start"]);
  });
});
