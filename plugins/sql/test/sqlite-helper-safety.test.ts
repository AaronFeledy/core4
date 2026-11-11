import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sqliteHelperImage } from "@lando/container-runtime/data-plane";
import { RedactionService } from "@lando/redaction/service";
import {
  ProviderCapabilityError,
  ProviderUnavailableError,
  SqlCommandFailedError,
  SqlDatabasePathError,
  SqlRecoveryUnavailableError,
} from "@lando/sdk/errors";
import { AbsolutePath } from "@lando/sdk/schema";
import type { EphemeralRunSpec } from "@lando/sdk/services";
import { Cause, Effect, Exit, Option } from "effect";
import {
  prepareSqliteHelper,
  removeSqliteHelperScratch,
  requireSqliteDatabaseHeader,
  runSqliteHelper,
  withSqliteHelper,
} from "../src/sqlite-helper.ts";
import type { SqlPlanService } from "../src/views.ts";

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
const setup = () => {
  const root = mkdtempSync(join(tmpdir(), "lando-sqlite-helper-"));
  directories.push(root);
  const applied = {
    id: "app",
    root: AbsolutePath.make(root),
    identity: { appRoot: AbsolutePath.make(root), ownerKey: "owner" },
  };
  const service: SqlPlanService = {
    name: "appserver",
    type: "php:8.3",
    environment: {},
    extensions: {},
    storage: [],
    mounts: [
      {
        type: "bind",
        source: root,
        target: "/app",
        role: "app",
        readOnly: false,
        realization: "accelerated",
      },
    ],
  };
  const target = {
    kind: "file",
    name: "appserver",
    type: "php:8.3",
    family: "sqlite",
    path: "data/site.sqlite",
  } as const;
  const deps = {
    applied,
    paths: { ownerSnapshotsDir: () => root },
    inspect: () =>
      Effect.succeed({
        status: "running" as const,
        running: true,
        containerId: "live-container",
        imageIdentity: "image",
      }),
    privateFileAccess: { enforce: async () => undefined, verify: async () => undefined },
    pullArtifact: () => Effect.succeed({ digest: sqliteHelperImage.digest }),
    run: (_spec: EphemeralRunSpec) => Effect.succeed({ exitCode: 0, stdout: "1234:2345\n", stderr: "" }),
  };
  return { root, service, target, deps };
};

test("borrows the inspected accelerated app mounts and binds only private scratch", async () => {
  const f = setup();
  const runs: EphemeralRunSpec[] = [];
  const helper = await Effect.runPromise(
    prepareSqliteHelper(
      {
        ...f.deps,
        run: (spec) => {
          runs.push(spec);
          return f.deps.run(spec);
        },
      },
      f.service,
      f.target,
      true,
    ),
  );
  expect(runs[0]).toMatchObject({
    user: "0:0",
    mountsFrom: { containerId: "live-container", readOnly: true },
  });
  expect(runs[0]?.mounts).toBeUndefined();
  expect(runs[0]?.binds).toBeUndefined();
  expect(helper.spec).toMatchObject({
    user: "1234:2345",
    mountsFrom: { containerId: "live-container", readOnly: false },
  });
  expect(helper.spec.binds).toEqual([{ source: helper.scratchHost, target: helper.scratchTarget }]);
  expect(statSync(join(helper.scratchHost, "..")).mode & 0o777).toBe(0o700);
  expect(statSync(join(helper.scratchHost, "../..")).mode & 0o777).toBe(0o700);
  await Effect.runPromise(removeSqliteHelperScratch(helper.scratchHost));
});

test("refuses a missing container with lando start remediation", async () => {
  const f = setup();
  const error = await Effect.runPromise(
    prepareSqliteHelper(
      { ...f.deps, inspect: () => Effect.succeed({ status: "missing", running: false }) },
      f.service,
      f.target,
    ).pipe(Effect.flip),
  );
  expect(error).toBeInstanceOf(SqlRecoveryUnavailableError);
  expect(error.remediation).toContain("lando start");
});

test("retains borrowed-subpath refusal guidance at the SQL boundary", async () => {
  const f = setup();
  const error = await Effect.runPromise(
    prepareSqliteHelper(
      {
        ...f.deps,
        run: () =>
          Effect.fail(
            new ProviderCapabilityError({
              providerId: "test",
              operation: "run.mountsFrom",
              capability: "volume-subpath",
              requiredValue: "Preserved subpath",
              actualValue: "VolumesFrom drops Subpath",
              message: "Cannot safely borrow a volume subpath.",
              remediation: "Helper was not started.",
            }),
          ),
      },
      f.service,
      f.target,
    ).pipe(Effect.flip),
  );
  expect(error).toBeInstanceOf(SqlCommandFailedError);
  expect(error.message).toContain("volume subpaths");
  expect(error.remediation).toContain("helper was not started");
  expect(existsSync(join(f.root, "sqlite-helper"))).toBe(false);
});

test("fails before scratch allocation on failed or invalid ownership inspection", async () => {
  for (const result of [
    { exitCode: 66, stdout: "", stderr: "missing" },
    { exitCode: 0, stdout: "", stderr: "" },
    { exitCode: 0, stdout: "100:200\n0:0", stderr: "" },
  ]) {
    const f = setup();
    const exit = await Effect.runPromiseExit(
      prepareSqliteHelper({ ...f.deps, run: () => Effect.succeed(result) }, f.service, f.target),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(existsSync(join(f.root, "sqlite-helper"))).toBe(false);
  }
});

test("ownership inspection rejects symlink components and permits missing mutation targets", async () => {
  const f = setup();
  writeFileSync(join(f.root, "site.sqlite"), "SQLite format 3\0");
  symlinkSync(f.root, join(f.root, "alias"));
  const service = {
    ...f.service,
    mounts: [
      { type: "bind" as const, source: f.root, target: f.root, role: "app" as const, readOnly: false },
    ],
  };
  const run = (spec: EphemeralRunSpec) =>
    Effect.tryPromise({
      try: async () => {
        const child = Bun.spawn([...spec.command], { stdout: "pipe", stderr: "pipe" });
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        return { exitCode, stdout, stderr };
      },
      catch: (cause) => cause,
    });
  for (const [path, mutation, succeeds] of [
    ["site.sqlite", false, true],
    ["missing/site.sqlite", false, false],
    ["missing/site.sqlite", true, true],
    ["alias/site.sqlite", true, false],
  ] as const) {
    const exit = await Effect.runPromiseExit(
      withSqliteHelper(
        { ...f.deps, run },
        service,
        { ...f.target, path },
        (helper) => Effect.succeed(helper.existed),
        { mutation },
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(succeeds);
    if (Exit.isSuccess(exit)) expect(exit.value).toBe(path === "site.sqlite");
  }
});

test("explains an unusable database path with a tagged reason instead of the probe script", async () => {
  const f = setup();
  writeFileSync(join(f.root, "site.sqlite"), "SQLite format 3\0");
  writeFileSync(join(f.root, "blocker"), "not a directory");
  mkdirSync(join(f.root, "folder.sqlite"));
  symlinkSync(f.root, join(f.root, "alias"));
  const service = {
    ...f.service,
    mounts: [
      { type: "bind" as const, source: f.root, target: f.root, role: "app" as const, readOnly: false },
    ],
  };
  const run = (spec: EphemeralRunSpec) =>
    Effect.tryPromise({
      try: async () => {
        const child = Bun.spawn([...spec.command], { stdout: "pipe", stderr: "pipe" });
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        return { exitCode, stdout, stderr };
      },
      catch: (cause) => cause,
    });
  for (const [path, mutation, reason] of [
    ["missing/site.sqlite", false, "missing"],
    ["alias/site.sqlite", false, "symlink"],
    ["folder.sqlite", true, "not-a-file"],
    ["blocker/site.sqlite", true, "parent-not-directory"],
  ] as const) {
    const exit = await Effect.runPromiseExit(
      withSqliteHelper({ ...f.deps, run }, service, { ...f.target, path }, () => Effect.void, { mutation }),
    );
    const failure = Exit.isFailure(exit)
      ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))
      : undefined;
    expect(failure).toBeInstanceOf(SqlDatabasePathError);
    if (!(failure instanceof SqlDatabasePathError)) continue;
    expect({ reason: failure.reason, path: failure.path, service: failure.service }).toEqual({
      reason,
      path,
      service: "appserver",
    });
    expect(failure.message).not.toContain("sqlite-owner");
  }
});

test("permits read-only export mounts and refuses read-only mutations or tmpfs", async () => {
  const f = setup();
  const readonly = { ...f.service, mounts: f.service.mounts.map((mount) => ({ ...mount, readOnly: true })) };
  await Effect.runPromise(withSqliteHelper(f.deps, readonly, f.target, () => Effect.void));
  for (const service of [
    readonly,
    { ...f.service, mounts: [...f.service.mounts, { type: "tmpfs" as const, target: "/app/data" }] },
  ]) {
    expect(
      Exit.isFailure(await Effect.runPromiseExit(prepareSqliteHelper(f.deps, service, f.target, true))),
    ).toBe(true);
  }
});

test("preserves only captured recovery evidence after failure", async () => {
  const f = setup();
  for (const preserveOnFailure of [true, false]) {
    let scratch = "";
    const exit = await Effect.runPromiseExit(
      withSqliteHelper(
        f.deps,
        f.service,
        f.target,
        (helper) => {
          scratch = helper.scratchHost;
          writeFileSync(join(scratch, "recovery.sqlite"), "recovery");
          writeFileSync(join(scratch, "input.sql"), "private input");
          return Effect.fail("primary");
        },
        { recoveryFile: () => (preserveOnFailure ? join(scratch, "recovery.sqlite") : undefined) },
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(existsSync(scratch)).toBe(preserveOnFailure);
    expect(existsSync(join(scratch, "input.sql"))).toBe(false);
  }
});

test("rejects symlinked SQLite snapshot payloads before reading", async () => {
  const f = setup();
  writeFileSync(join(f.root, "db"), "SQLite format 3\0payload");
  symlinkSync(join(f.root, "db"), join(f.root, "linked"));
  const error = await Effect.runPromise(
    requireSqliteDatabaseHeader(join(f.root, "linked"), "appserver", "Invalid snapshot").pipe(Effect.flip),
  );
  expect(error).toBeInstanceOf(SqlRecoveryUnavailableError);
});

test("reports cleanup failure without replacing primary failure", async () => {
  const f = setup();
  expect(Exit.isFailure(await Effect.runPromiseExit(removeSqliteHelperScratch("invalid\0path")))).toBe(true);
  for (const bodyFails of [true, false]) {
    const exit = await Effect.runPromiseExit(
      withSqliteHelper(f.deps, f.service, f.target, (helper) => {
        Object.assign(helper, { scratchRoot: "invalid\0path" });
        return bodyFails ? Effect.fail("primary") : Effect.succeed("completed");
      }),
    );
    if (bodyFails) {
      if (!Exit.isFailure(exit)) throw new Error("Expected failure");
      expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))).toBe("primary");
    } else {
      if (!Exit.isSuccess(exit)) throw new Error("Expected completed operation");
      expect(exit.value).toBe("completed");
    }
  }
});

test("reports the SQLite file and busy process after a bounded lock failure", async () => {
  const f = setup();
  const error = await Effect.runPromise(
    withSqliteHelper(f.deps, f.service, f.target, (helper) =>
      runSqliteHelper(
        { ...f.deps, run: () => Effect.succeed({ exitCode: 5, stdout: "", stderr: "database is locked" }) },
        f.target,
        helper,
        ["sqlite3", helper.dbPath],
      ),
    ).pipe(Effect.flip),
  );
  expect(error).toBeInstanceOf(SqlCommandFailedError);
  expect(error.message).toContain("/app/data/site.sqlite");
  expect(error.remediation).toContain("Another process");
});

for (const providerFailure of [true, false]) {
  test(`SQLite ${providerFailure ? "provider failure text" : "stderr"} uses bounded secret-aware capture`, async () => {
    const f = setup();
    const secret = "sqlite-private-token";
    await Effect.runPromise(
      Effect.gen(function* () {
        const redaction = yield* RedactionService;
        yield* redaction.registerValues([secret], { match: "substring" });
        const error = yield* withSqliteHelper(f.deps, f.service, f.target, (helper) =>
          runSqliteHelper(
            {
              ...f.deps,
              run: () =>
                providerFailure
                  ? Effect.fail(
                      new ProviderUnavailableError({
                        providerId: "test",
                        operation: "run",
                        message: `provider ${secret}`,
                        remediation: "Retry.",
                      }),
                    )
                  : Effect.succeed({
                      exitCode: 2,
                      stdout: "",
                      stderr: `${"noise\n".repeat(4000)} ${secret}`,
                    }),
            },
            f.target,
            helper,
            ["sqlite3", helper.dbPath],
          ),
        ).pipe(Effect.flip);
        expect(error).toBeInstanceOf(SqlCommandFailedError);
        if (!(error instanceof SqlCommandFailedError)) throw error;
        expect(error.stderrTail).not.toContain(secret);
        expect(error.stderrTail).toContain("[redacted]");
        expect(error.stderrTail?.length ?? 0).toBeLessThanOrEqual(8192);
      }).pipe(Effect.provide(RedactionService.layer)),
    );
  });
}
