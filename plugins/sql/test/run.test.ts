import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect, Exit } from "effect";

import {
  SqlCommandFailedError,
  SqlConfirmRequiredError,
  SqlDumpNotFoundError,
  SqlRecoveryOperationError,
  SqlRecoveryUnavailableError,
  SqlSeedSourceError,
  SqlSeedStateError,
  SqlServiceAmbiguousError,
  VolumeNotFoundError,
} from "@lando/sdk/errors";
import { AbsolutePath, AppId, ServiceName } from "@lando/sdk/schema";

import { wrapExportCommand, wrapImportCommand } from "../src/gzip.ts";
import { dbInputFromCommand, executeDbCommand } from "../src/run.ts";
import { FakeRestoreError, cleanupSqlTestDeps, makeSqlTestDeps } from "./support/fakes.ts";

const SECRET = "s3cret-pass";

afterEach(cleanupSqlTestDeps);

const run = (
  deps: ReturnType<typeof makeSqlTestDeps>["deps"],
  input: Parameters<typeof executeDbCommand>[1],
) => Effect.runPromiseExit(Effect.scoped(executeDbCommand(deps, input)));

describe("executeDbCommand", () => {
  test("maps the db:seed snapshot flag to its physical source", () => {
    const input = dbInputFromCommand("seed", {
      argv: [],
      parsedArgv: [],
      flags: { snapshot: "snapshot-id" },
      args: {},
    });

    expect(input.snapshotId).toBe("snapshot-id");
  });

  test("maps explicit snapshot source selectors", () => {
    // Given: snapshot listing flags naming a sibling app and its canonical root.
    const input = dbInputFromCommand("snapshots", {
      argv: [],
      parsedArgv: [],
      flags: { "from-app": "sibling", "from-path": "/workspace/sibling" },
      args: {},
    });

    // When: the command boundary parses those selectors.
    const fromApp = Reflect.get(input, "fromApp");
    const fromPath = Reflect.get(input, "fromPath");

    // Then: both typed selectors survive into SQL execution input.
    expect({ fromApp, fromPath }).toEqual({ fromApp: "sibling", fromPath: "/workspace/sibling" });
  });

  test("lists only snapshots owned by the current canonical app root by default", async () => {
    // Given: snapshots stored under an app id shared by more than one worktree.
    const harness = makeSqlTestDeps({ password: SECRET });

    // When: the user lists snapshots without an explicit source selector.
    await run(harness.deps, { action: "snapshots", yes: false });

    // Then: the query is constrained by planner-owned app identity.
    expect(harness.snapshotFilters()).toEqual([
      { app: AppId.make("sql-app"), store: "sql-app_database_data", ownerKey: "owner:sql-app" },
    ]);
  });

  test("constrains an explicit app source to sibling worktrees in the same repository", async () => {
    // Given: an app with a proven Git repository group.
    const harness = makeSqlTestDeps({ password: SECRET });

    // When: a sibling app name is selected explicitly.
    const exit = await run(harness.deps, { action: "snapshots", fromApp: "sibling", yes: false });

    // Then: both the logical app and repository group constrain the query.
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(harness.snapshotFilters()).toEqual([
      {
        app: AppId.make("sibling"),
        service: ServiceName.make("database"),
        repoGroupKey: "repository:sql-app",
      },
    ]);
  });

  test("fails closed for an app source when repository grouping is unavailable", async () => {
    // Given: an app planned outside a Git repository.
    const harness = makeSqlTestDeps({ password: SECRET });
    const deps = {
      ...harness.deps,
      plan: {
        id: harness.deps.plan.id,
        name: harness.deps.plan.name,
        root: harness.deps.plan.root,
        services: harness.deps.plan.services,
      },
    };

    // When: a logical app source is selected without repository proof.
    const exit = await run(deps, { action: "snapshots", fromApp: "sibling", yes: false });

    // Then: listing fails before querying snapshots from an unrelated project.
    expect(Exit.isFailure(exit)).toBe(true);
    expect(harness.snapshotFilters()).toEqual([]);
  });

  test("canonicalizes an explicit path source before listing snapshots", async () => {
    // Given: a relative source path that traverses a symbolic link.
    const harness = makeSqlTestDeps({ password: SECRET });
    const sibling = join(harness.root, "sibling");
    const alias = join(harness.root, "sibling-link");
    mkdirSync(sibling);
    symlinkSync(sibling, alias, "dir");

    // When: the linked path is selected explicitly.
    const exit = await run(harness.deps, {
      action: "snapshots",
      fromPath: "sibling-link",
      hostCwd: harness.root,
      yes: false,
    });

    // Then: the query uses the canonical physical source root.
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(harness.snapshotFilters()).toEqual([
      { sourceRoot: AbsolutePath.make(sibling), service: ServiceName.make("database") },
    ]);
  });

  test("fails closed when an explicit snapshot source path cannot be resolved", async () => {
    // Given: a path selector that does not identify an existing app root.
    const harness = makeSqlTestDeps({ password: SECRET });

    // When: snapshots are listed from the missing path.
    const exit = await run(harness.deps, {
      action: "snapshots",
      fromPath: "missing-app",
      hostCwd: harness.root,
      yes: false,
    });

    // Then: the typed recovery failure prevents an unconstrained snapshot query.
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) throw new Error("expected failure");
    expect(exit.cause._tag === "Fail" ? exit.cause.error : undefined).toBeInstanceOf(
      SqlRecoveryUnavailableError,
    );
    expect(harness.snapshotFilters()).toEqual([]);
  });

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
      expect(transfer.from.command).toEqual(
        wrapExportCommand(
          [
            "mysqldump",
            "-u",
            "lando",
            "--single-transaction",
            "--quick",
            "--set-gtid-purged=OFF",
            "--no-tablespaces",
            "sql-app",
          ],
          true,
        ),
      );
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

    const exit = await run(harness.deps, { action: "import", file: "dump.bak", yes: true });

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

  test("fails closed when the import dump exists but is unreadable, before the count probe", async () => {
    // root bypasses mode bits, so the permission miss cannot be provoked there.
    if (process.getuid?.() === 0 || process.platform === "win32") return;
    const harness = makeSqlTestDeps({ password: SECRET, countStdout: "3" });
    const locked = join(harness.root, "locked.sql.gz");
    writeFileSync(locked, "x");
    chmodSync(locked, 0o000);

    const exit = await run(harness.deps, { action: "import", file: "locked.sql.gz", yes: false });

    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) throw new Error("expected failure");
    const error = exit.cause._tag === "Fail" ? exit.cause.error : undefined;
    expect(error).toBeInstanceOf(SqlDumpNotFoundError);
    if (error instanceof SqlDumpNotFoundError) expect(error.message).toContain("not readable");
    // Neither the count probe nor the overwrite confirmation ran.
    expect(harness.execs()).toEqual([]);
    expect(harness.published()).toEqual([]);
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

  test("resolves a relative import dump from hostCwd when it is inside the app root", async () => {
    const harness = makeSqlTestDeps({ password: SECRET, countStdout: "0" });
    const nested = join(harness.root, "backups");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "nested.sql.gz"), "x");

    const exit = await run(harness.deps, {
      action: "import",
      file: "nested.sql.gz",
      yes: true,
      hostCwd: nested,
    });

    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isFailure(exit)) throw new Error("expected success");
    expect(exit.value.file).toBe(join(nested, "nested.sql.gz"));
  });

  test("marks an explicitly selected external import file as trusted after hashing it", async () => {
    const harness = makeSqlTestDeps({ password: SECRET, countStdout: "0" });
    const external = join(harness.root, "..", `external-${Date.now()}.sql`);
    writeFileSync(external, "SELECT 1;");
    try {
      const exit = await run(harness.deps, { action: "import", file: external, yes: true });

      expect(Exit.isSuccess(exit)).toBe(true);
      const transfer = harness.transfers()[0];
      expect(transfer?.from._tag).toBe("hostPath");
      if (transfer?.from._tag === "hostPath") expect(transfer.from.trusted).toBe(true);
    } finally {
      rmSync(external, { force: true });
    }
  });

  test("requires confirmation before importing into an empty database", async () => {
    const harness = makeSqlTestDeps({ password: SECRET, countStdout: "0" });

    const exit = await run(harness.deps, { action: "import", file: "dump.sql.gz", yes: false });

    expect(Exit.isFailure(exit)).toBe(true);
    expect(harness.transfers()).toHaveLength(0);
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
    expect(transfer?.expectedDigest).toMatch(/^[a-f0-9]{64}$/u);
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
    const rootPassword = "root-reset-secret";
    const harness = makeSqlTestDeps({ password: SECRET, rootPassword });

    const denied = await run(harness.deps, { action: "reset", yes: false });
    expect(denied._tag).toBe("Failure");
    expect(harness.execs()).toEqual([]);

    const allowed = await run(harness.deps, { action: "reset", yes: true });
    expect(Exit.isSuccess(allowed)).toBe(true);
    expect(harness.snapshots()).toHaveLength(1);
    expect(harness.snapshots()[0]?.metadata?.recoveryReason).toBe("reset");
    const exec = harness.execs()[0];
    expect(exec?.command[0]).toBe("mysql");
    expect(exec?.command.slice(0, 3)).toEqual(["mysql", "-u", "root"]);
    expect(exec?.env?.MYSQL_PWD).toBe(rootPassword);
    expect(exec?.command.join(" ")).not.toContain(SECRET);
    expect(exec?.command.join(" ")).not.toContain(rootPassword);
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
    const error = exit.cause._tag === "Fail" ? exit.cause.error : undefined;
    expect(error).toBeInstanceOf(SqlRecoveryOperationError);
    if (error instanceof SqlRecoveryOperationError) {
      expect(error.cause).toBeInstanceOf(SqlCommandFailedError);
      expect(error.recoverySnapshotId).toMatch(/^snap-/u);
    }
  });

  test("waits for the restarted database before running reset", async () => {
    const harness = makeSqlTestDeps({ password: SECRET, countFailuresBeforeSuccess: 1 });

    const exit = await run(harness.deps, { action: "reset", yes: true });

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(harness.countAttempts()).toBe(2);
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
    expect(exit.value.snapshotId).not.toBe("before-change");
    expect(harness.snapshots()[0]?.store).toBe("sql-app_database_data");
    expect(harness.snapshots()[0]?.format).toBe("tar.gz");
    const metadata = harness.snapshots()[0]?.metadata;
    expect(String(metadata?.sourceRoot)).toBe(harness.root);
    expect(String(metadata?.service)).toBe("database");
    expect(metadata?.volumeInstanceId).toBe("volume-instance:sql-app_database_data");
    expect(metadata?.family).toBe("mysql");
    expect(metadata?.version).toBe("8.0");
    expect(metadata?.imageIdentity).toBe("sha256:mysql-runtime");
    expect(metadata?.recoveryReason).toBe("manual");
  });

  test("uses the effective artifact version when the service type is unversioned", async () => {
    const harness = makeSqlTestDeps({ password: SECRET, type: "mysql", version: "8.0" });

    const exit = await run(harness.deps, { action: "snapshot", yes: false });

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(harness.snapshots()[0]?.metadata?.version).toBe("8.0");
  });

  test("creates zstd snapshots when explicitly requested", async () => {
    const harness = makeSqlTestDeps({ password: SECRET });

    const exit = await run(harness.deps, {
      action: "snapshot",
      compression: "zstd",
      yes: false,
    });

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(harness.snapshots()[0]?.format).toBe("tar.zst");
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
    const harness = makeSqlTestDeps({ password: SECRET, countFailuresBeforeSuccess: 1 });

    const exit = await run(harness.deps, { action: "restore", snapshotId: "before-change", yes: true });

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(harness.lifecycle()).toEqual(["lock", "stop", "snapshot", "restore", "start"]);
    expect(harness.countAttempts()).toBe(2);
  });

  test("leaves the service stopped after a failed restore", async () => {
    const harness = makeSqlTestDeps({ password: SECRET, restoreFails: true });

    const exit = await run(harness.deps, { action: "restore", snapshotId: "before-change", yes: true });

    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) throw new Error("expected failure");
    const error = exit.cause._tag === "Fail" ? exit.cause.error : undefined;
    expect(error).toBeInstanceOf(SqlRecoveryOperationError);
    if (error instanceof SqlRecoveryOperationError) {
      expect(error.cause).toBeInstanceOf(FakeRestoreError);
      expect(error.recoverySnapshotId).toMatch(/^snap-/u);
    }
    expect(harness.lifecycle()).toEqual(["lock", "stop", "snapshot", "restore"]);
  });

  test("does not start a previously stopped service after successful restore", async () => {
    const harness = makeSqlTestDeps({
      password: SECRET,
      initiallyRunning: false,
      omitImageIdentity: true,
    });

    const exit = await run(harness.deps, { action: "restore", snapshotId: "before-change", yes: true });

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(harness.lifecycle()).toEqual(["lock", "snapshot", "restore"]);
  });

  test("fails closed before restoring a snapshot from another database version", async () => {
    const harness = makeSqlTestDeps({ password: SECRET, snapshotVersion: "5.7" });

    const exit = await run(harness.deps, { action: "restore", snapshotId: "before-change", yes: true });

    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) throw new Error("expected failure");
    expect(exit.cause._tag === "Fail" ? exit.cause.error : undefined).toBeInstanceOf(
      SqlRecoveryUnavailableError,
    );
    expect(harness.lifecycle()).toEqual(["lock"]);
  });

  test("fails closed before mutating when a snapshot belongs to another physical volume", async () => {
    const harness = makeSqlTestDeps({
      password: SECRET,
      snapshotVolumeInstance: "volume-instance:foreign",
    });

    const exit = await run(harness.deps, { action: "restore", snapshotId: "foreign", yes: true });

    expect(Exit.isFailure(exit)).toBe(true);
    expect(harness.lifecycle()).toEqual(["lock"]);
  });

  test("seeds a provenance-confirmed fresh empty volume from a logical dump", async () => {
    const harness = makeSqlTestDeps({ password: SECRET, countStdout: "0" });

    const exit = await run(harness.deps, { action: "seed", file: "dump.sql.gz", yes: false });

    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isFailure(exit)) throw new Error("expected success");
    expect(exit.value.seedStatus).toBe("seeded");
    expect(harness.transfers()).toHaveLength(1);
    expect(harness.snapshots()).toHaveLength(0);
  });

  test("seeds a provenance-confirmed fresh volume from a compatible physical snapshot", async () => {
    const harness = makeSqlTestDeps({ password: SECRET, countStdout: "0" });

    const exit = await run(harness.deps, { action: "seed", snapshotId: "seed-source", yes: false });

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(harness.lifecycle()).toEqual(["lock", "stop", "restore", "start"]);
  });

  test("quarantines an interrupted seed instead of trusting an empty database", async () => {
    const harness = makeSqlTestDeps({ password: SECRET, countStdout: "0", seedStatus: "in-progress" });

    const exit = await run(harness.deps, { action: "seed", file: "dump.sql.gz", yes: false });

    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) throw new Error("expected failure");
    expect(exit.cause._tag === "Fail" ? exit.cause.error : undefined).toBeInstanceOf(SqlSeedStateError);
    expect(harness.transfers()).toHaveLength(0);
  });

  test("requires exactly one seed source", async () => {
    const harness = makeSqlTestDeps({ password: SECRET, countStdout: "0" });

    const exit = await run(harness.deps, { action: "seed", yes: false });

    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) throw new Error("expected failure");
    expect(exit.cause._tag === "Fail" ? exit.cause.error : undefined).toBeInstanceOf(SqlSeedSourceError);
  });
});
