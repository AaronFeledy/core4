import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sqliteHelperImage } from "@lando/container-runtime/data-plane";
import { SqlRecoveryUnavailableError } from "@lando/sdk/errors";
import { AbsolutePath, type AppPlan } from "@lando/sdk/schema";
import type { EphemeralRunSpec } from "@lando/sdk/services";
import { Cause, Effect, Exit, Option } from "effect";

import {
  prepareSqliteHelper,
  removeSqliteHelperScratch,
  requireSqliteDatabaseHeader,
  withSqliteHelper,
} from "../src/sqlite-helper.ts";
import type { SqlPlanService } from "../src/views.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), "lando-sqlite-owner-"));
  directories.push(root);
  const applied = {
    id: "app",
    root: AbsolutePath.make(root),
    identity: { appRoot: AbsolutePath.make(root), ownerKey: "owner-key" },
  } as AppPlan;
  const service: SqlPlanService = {
    name: "appserver",
    type: "php:8.3",
    environment: {},
    mounts: [
      { type: "bind", source: root, target: "/app", readOnly: false, role: "app" },
      { type: "volume", store: "appserver_data", target: "/app/data", readOnly: false },
    ],
    storage: [],
  };
  const target = {
    kind: "file" as const,
    name: "appserver",
    type: "php:8.3",
    family: "sqlite" as const,
    path: "data/site.sqlite",
  };
  const paths = { ownerSnapshotsDir: (key: string) => join(root, "snapshots", key) };
  const pullArtifact = () => Effect.succeed({ digest: sqliteHelperImage.digest });
  return { root, applied, service, target, paths, pullArtifact };
};

test("inspects named-volume file ownership read-only and uses that identity for the helper", async () => {
  const setupData = setup();
  const runs: EphemeralRunSpec[] = [];
  const deps = {
    ...setupData,
    run: (spec: EphemeralRunSpec) => {
      runs.push(spec);
      return Effect.succeed({ exitCode: 0, stdout: "1234:2345\n", stderr: "" });
    },
  };
  const helper = await Effect.runPromise(prepareSqliteHelper(deps, setupData.service, setupData.target));
  expect(runs).toHaveLength(1);
  expect(runs[0]).toMatchObject({
    image: sqliteHelperImage.ref,
    user: "0:0",
    captureStdout: true,
    binds: [],
    owner: { app: "app", plan: setupData.applied },
    mounts: [{ type: "volume", store: "appserver_data", target: "/app/data", readOnly: true }],
  });
  expect(runs[0]?.command.at(-1)).toBe("/app/data/site.sqlite");
  expect(helper.spec.user).toBe("1234:2345");
  expect(helper.spec.mounts?.[0]?.readOnly).toBe(false);
  await Effect.runPromise(removeSqliteHelperScratch(helper.scratchHost));
});

test("fails before scratch allocation when ownership inspection fails or returns invalid data", async () => {
  for (const result of [
    { exitCode: 66, stdout: "", stderr: "missing file" },
    { exitCode: 0, stdout: "", stderr: "" },
    { exitCode: 0, stdout: "100:200\n0:0", stderr: "" },
  ]) {
    const setupData = setup();
    const deps = { ...setupData, run: () => Effect.succeed(result) };
    const exit = await Effect.runPromiseExit(prepareSqliteHelper(deps, setupData.service, setupData.target));
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) throw new Error("Expected ownership inspection failure");
    expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))).toBeInstanceOf(
      SqlRecoveryUnavailableError,
    );
    expect(existsSync(join(setupData.paths.ownerSnapshotsDir("owner-key"), "sqlite-helper"))).toBe(false);
  }
});

test("ownership inspection rejects missing files and symlinked path components", async () => {
  const setupData = setup();
  const database = join(setupData.root, "site.sqlite");
  writeFileSync(database, "SQLite format 3\0");
  symlinkSync(setupData.root, join(setupData.root, "alias"));
  const seen: Array<{ path: string; exitCode: number }> = [];
  for (const file of [
    database,
    join(setupData.root, "missing.sqlite"),
    join(setupData.root, "alias", "site.sqlite"),
  ]) {
    const service: SqlPlanService = {
      ...setupData.service,
      mounts: [
        { type: "bind", source: setupData.root, target: setupData.root, role: "app", readOnly: false },
      ],
    };
    const target = { ...setupData.target, path: file.slice(setupData.root.length + 1) };
    const deps = {
      ...setupData,
      run: (spec: EphemeralRunSpec) =>
        Effect.tryPromise({
          try: async () => {
            const process = Bun.spawn([...spec.command], { stdout: "pipe", stderr: "pipe" });
            const [exitCode, stdout, stderr] = await Promise.all([
              process.exited,
              new Response(process.stdout).text(),
              new Response(process.stderr).text(),
            ]);
            seen.push({ path: file, exitCode });
            return { exitCode, stdout, stderr };
          },
          catch: (cause) => cause,
        }),
    };
    const exit = await Effect.runPromiseExit(withSqliteHelper(deps, service, target, () => Effect.void));
    expect(Exit.isSuccess(exit)).toBe(file === database);
  }
  expect(seen.map((result) => result.exitCode)).toEqual([0, 66, 65]);
});

test("preserves failed-operation scratch only when requested", async () => {
  const setupData = setup();
  const deps = { ...setupData, run: () => Effect.succeed({ exitCode: 0, stdout: "100:200\n", stderr: "" }) };
  for (const preserveOnFailure of [true, false]) {
    let scratch = "";
    const exit = await Effect.runPromiseExit(
      withSqliteHelper(
        deps,
        setupData.service,
        setupData.target,
        (helper) => {
          scratch = helper.scratchHost;
          writeFileSync(join(scratch, "recovery.sqlite"), "recovery evidence");
          return Effect.fail("mutation failed");
        },
        { preserveOnFailure },
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(existsSync(scratch)).toBe(preserveOnFailure);
  }
});

test("rejects a symlinked SQLite snapshot payload before reading it", async () => {
  const setupData = setup();
  const database = join(setupData.root, "database.sqlite");
  const linked = join(setupData.root, "linked.sqlite");
  writeFileSync(database, "SQLite format 3\0payload");
  symlinkSync(database, linked);
  const exit = await Effect.runPromiseExit(
    requireSqliteDatabaseHeader(linked, "appserver", "Snapshot payload invalid"),
  );
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) throw new Error("Expected symlink payload rejection");
  const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
  expect(error).toBeInstanceOf(SqlRecoveryUnavailableError);
  expect(existsSync(database)).toBe(true);
});

test("reports cleanup failure without replacing a primary operation failure", async () => {
  const setupData = setup();
  const deps = { ...setupData, run: () => Effect.succeed({ exitCode: 0, stdout: "100:200\n", stderr: "" }) };
  const invalidPath = "invalid\0sqlite-scratch";
  const direct = await Effect.runPromiseExit(removeSqliteHelperScratch(invalidPath));
  expect(Exit.isFailure(direct)).toBe(true);
  if (!Exit.isFailure(direct)) throw new Error("Expected typed cleanup failure");
  expect(Option.getOrUndefined(Cause.findErrorOption(direct.cause))).toBeInstanceOf(
    SqlRecoveryUnavailableError,
  );
  for (const bodyFails of [false, true]) {
    const exit = await Effect.runPromiseExit(
      withSqliteHelper(deps, setupData.service, setupData.target, (helper) => {
        Object.assign(helper, { scratchHost: invalidPath });
        return bodyFails ? Effect.fail("primary mutation failure") : Effect.succeed("completed");
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) throw new Error("Cleanup failure cannot report success");
    const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
    if (bodyFails) expect(error).toBe("primary mutation failure");
    else expect(error).toBeInstanceOf(SqlRecoveryUnavailableError);
  }
});
