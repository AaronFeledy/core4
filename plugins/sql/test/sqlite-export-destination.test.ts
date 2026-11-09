import { expect, test } from "bun:test";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlRecoveryUnavailableError } from "@lando/sdk/errors";
import { Effect, Result } from "effect";
import { ensureSqliteExportDestination } from "../src/sqlite-export-destination.ts";
import type { SqlFileTarget } from "../src/target.ts";
import type { SqlPlanMount, SqlPlanService } from "../src/views.ts";

const appService = (mounts: ReadonlyArray<SqlPlanMount>): SqlPlanService => ({
  name: "app",
  type: "php",
  environment: {},
  extensions: {},
  storage: [],
  mounts,
});

const target: SqlFileTarget = {
  kind: "file",
  name: "app",
  type: "php",
  family: "sqlite",
  path: "data/site.sqlite",
};

test.each([
  "same",
  "dot",
  "symlink",
  "hardlink",
  "-wal",
  "-shm",
  "-journal",
  "sidecar-hardlink",
  "missing-sidecar",
])("rejects SQLite export alias %s", async (kind) => {
  const root = await mkdtemp(join(tmpdir(), "lando-sqlite-export-"));
  try {
    await mkdir(join(root, "data"));
    const database = join(root, "data/site.sqlite");
    await writeFile(database, "live database");
    let destination = database;
    switch (kind) {
      case "same":
        break;
      case "dot":
        destination = `${root}/./data/site.sqlite`;
        break;
      case "symlink":
        destination = join(root, "alias.sql");
        await symlink(database, destination);
        break;
      case "hardlink":
        destination = join(root, "alias.sql");
        await link(database, destination);
        break;
      case "-wal":
      case "-shm":
      case "-journal":
        destination = `${database}${kind}`;
        await writeFile(destination, "sidecar");
        break;
      case "sidecar-hardlink":
        await writeFile(`${database}-wal`, "sidecar");
        destination = join(root, "alias.sql");
        await link(`${database}-wal`, destination);
        break;
      case "missing-sidecar":
        destination = `${database}-wal`;
        break;
    }
    const result = await Effect.runPromise(
      Effect.result(
        ensureSqliteExportDestination(
          appService([
            {
              type: "bind",
              source: root,
              target: "/app",
              readOnly: false,
              role: "app",
              realization: "accelerated",
              mountKey: "app-mount",
            },
          ]),
          target,
          destination,
        ),
      ),
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(SqlRecoveryUnavailableError);
      expect(result.failure.message).toContain("aliases SQLite database");
      expect(result.failure.remediation).toContain("Choose a separate dump file");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("allows a distinct existing dump destination", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-sqlite-export-"));
  try {
    await writeFile(join(root, "site.sqlite"), "database");
    await writeFile(join(root, "dump.sql"), "old dump");
    const result = await Effect.runPromise(
      Effect.result(
        ensureSqliteExportDestination(
          appService([{ type: "bind", source: root, target: "/app", readOnly: false, role: "app" }]),
          { ...target, path: "site.sqlite" },
          join(root, "dump.sql"),
        ),
      ),
    );
    expect(Result.isSuccess(result)).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
