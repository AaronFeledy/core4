import { describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";

import {
  SqlCommandFailedError,
  SqlConfirmRequiredError,
  SqlServiceAmbiguousError,
  VolumeNotFoundError,
} from "@lando/sdk/errors";

import { wrapExportCommand } from "../src/gzip.ts";
import { executeDbCommand } from "../src/run.ts";
import { makeSqlTestDeps } from "./support/fakes.ts";

const SECRET = "s3cret-pass";

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
    expect(exit.value.file).toBe("/tmp/sql-app/database.sql.gz");
    expect(exit.value.steps.length).toBeGreaterThan(0);

    const transfer = harness.transfers()[0];
    expect(transfer?.from._tag).toBe("serviceCmd");
    expect(transfer?.to._tag).toBe("hostPath");
    if (transfer?.from._tag === "serviceCmd") {
      expect(transfer.from.command).toEqual(wrapExportCommand(["mysqldump", "-u", "lando", "sql-app"], true));
      expect(transfer.from.env?.MYSQL_PWD).toBe(SECRET);
      expect(JSON.stringify(transfer.from.command)).not.toContain(SECRET);
    }
    expect(harness.redactionTokens()).toContain(SECRET);
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

  test("imports with --yes even when the database is non-empty", async () => {
    const harness = makeSqlTestDeps({ password: SECRET, countStdout: "3" });

    const exit = await run(harness.deps, { action: "import", file: "dump.sql.gz", yes: true });

    expect(Exit.isSuccess(exit)).toBe(true);
    const transfer = harness.transfers()[0];
    expect(transfer?.from._tag).toBe("hostPath");
    expect(transfer?.to._tag).toBe("serviceCmd");
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

  test("snapshots the first service volume through DataMover", async () => {
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
  });
});
