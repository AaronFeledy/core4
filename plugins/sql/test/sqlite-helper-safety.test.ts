import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { sqliteHelperImage } from "@lando/container-runtime/data-plane";
import {
  ProviderCapabilityError,
  ProviderUnavailableError,
  SqlCommandFailedError,
  SqlRecoveryUnavailableError,
} from "@lando/sdk/errors";
import { AbsolutePath, type AppPlan, type VolumeLocator } from "@lando/sdk/schema";
import type { EphemeralRunSpec } from "@lando/sdk/services";
import { Cause, Effect, Exit, Option } from "effect";

import {
  prepareSqliteHelper,
  removeSqliteHelperScratch,
  requireSqliteDatabaseHeader,
  runSqliteHelper,
  verifySqliteHelperVolume,
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
  const volumeIdentity = {
    coordinationKey: JSON.stringify(["test-daemon", "appserver_data"]),
    nativeName: "appserver_data",
    generation: "generation-1",
    ownerRoot: AbsolutePath.make(root),
    origin: "created" as const,
  };
  const locateVolume = () =>
    Effect.succeed({
      coordinationKey: volumeIdentity.coordinationKey,
      nativeName: volumeIdentity.nativeName,
      identity: volumeIdentity,
    });
  return { root, applied, service, target, paths, pullArtifact, volumeIdentity, locateVolume };
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
            if (spec.command.includes("sqlite-owner")) seen.push({ path: file, exitCode });
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

test("refuses named-volume inspection without canonical existing-volume proof", async () => {
  const setupData = setup();
  const valid = {
    coordinationKey: setupData.volumeIdentity.coordinationKey,
    nativeName: "appserver_data",
    identity: setupData.volumeIdentity,
  };
  const { locateVolume: _locateVolume, ...unsupported } = setupData;
  let runs = 0;
  const run = () => {
    runs++;
    return Effect.succeed({ exitCode: 0, stdout: "100:200\n", stderr: "" });
  };
  const withoutCapability = await Effect.runPromiseExit(
    prepareSqliteHelper({ ...unsupported, run }, setupData.service, setupData.target),
  );
  expect(Exit.isFailure(withoutCapability)).toBe(true);
  for (const locator of [
    { coordinationKey: valid.coordinationKey, nativeName: valid.nativeName },
    { ...valid, identity: { ...valid.identity, ownerRoot: AbsolutePath.make("/foreign-app") } },
    { ...valid, nativeName: "other-volume" },
    { ...valid, identity: { ...valid.identity, nativeName: "other-volume" } },
    { ...valid, coordinationKey: "different-daemon" },
    { ...valid, coordinationKey: "", identity: { ...valid.identity, coordinationKey: "" } },
    { ...valid, identity: { ...valid.identity, generation: "" } },
  ] satisfies VolumeLocator[]) {
    const exit = await Effect.runPromiseExit(
      prepareSqliteHelper(
        { ...setupData, run, locateVolume: () => Effect.succeed(locator) },
        setupData.service,
        setupData.target,
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit))
      expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))).toBeInstanceOf(
        SqlRecoveryUnavailableError,
      );
  }
  expect(runs).toBe(0);
  expect(existsSync(join(setupData.paths.ownerSnapshotsDir("owner-key"), "sqlite-helper"))).toBe(false);
});

test("rejects volume generation changes during file ownership inspection", async () => {
  const setupData = setup();
  let locations = 0;
  let runs = 0;
  const exit = await Effect.runPromiseExit(
    prepareSqliteHelper(
      {
        ...setupData,
        locateVolume: () =>
          Effect.succeed({
            coordinationKey: setupData.volumeIdentity.coordinationKey,
            nativeName: "appserver_data",
            identity: {
              ...setupData.volumeIdentity,
              generation: ++locations === 1 ? "generation-1" : "replacement",
            },
          }),
        run: () => {
          runs++;
          return Effect.succeed({ exitCode: 0, stdout: "100:200\n", stderr: "" });
        },
      },
      setupData.service,
      setupData.target,
    ),
  );
  expect(Exit.isFailure(exit)).toBe(true);
  expect(runs).toBe(1);
  expect(existsSync(join(setupData.paths.ownerSnapshotsDir("owner-key"), "sqlite-helper"))).toBe(false);
});

test("rechecks exact canonical volume identity before and after helper commands", async () => {
  const setupData = setup();
  let identity = setupData.volumeIdentity;
  let runs = 0;
  let replaceDuringCommand = false;
  const deps = {
    ...setupData,
    locateVolume: () =>
      Effect.succeed({
        coordinationKey: identity.coordinationKey,
        nativeName: identity.nativeName,
        identity,
      }),
    run: () => {
      runs++;
      if (replaceDuringCommand) identity = { ...identity, generation: "replacement" };
      return Effect.succeed({ exitCode: 0, stdout: "100:200\n", stderr: "" });
    },
  };
  const helper = await Effect.runPromise(prepareSqliteHelper(deps, setupData.service, setupData.target));
  try {
    expect(helper.volumeIdentity).toEqual(setupData.volumeIdentity);
    expect(helper.covering.kind).toBe("volume");
    identity = { ...identity, generation: "replacement" };
    const before = runs;
    const changedBefore = await Effect.runPromiseExit(
      runSqliteHelper(deps, setupData.target, helper, ["true"]),
    );
    expect(Exit.isFailure(changedBefore)).toBe(true);
    expect(runs).toBe(before);
    identity = setupData.volumeIdentity;
    replaceDuringCommand = true;
    const changedAfter = await Effect.runPromiseExit(
      runSqliteHelper(deps, setupData.target, helper, ["true"]),
    );
    expect(Exit.isFailure(changedAfter)).toBe(true);
    expect(runs).toBe(before + 1);
    const gap = await Effect.runPromiseExit(verifySqliteHelperVolume(deps, setupData.target, helper));
    expect(Exit.isFailure(gap)).toBe(true);
  } finally {
    await Effect.runPromise(removeSqliteHelperScratch(helper.scratchHost));
  }
});

test("proves a bind source through the helper view and removes the proof before database inspection", async () => {
  const f = setup();
  const service: SqlPlanService = {
    ...f.service,
    mounts: [{ type: "bind", source: f.root, target: f.root, role: "app", readOnly: false }],
  };
  const target = { ...f.target, path: "site.sqlite" };
  let proofPath = "";
  let statRuns = 0;
  const deps = {
    ...f,
    run: (spec: EphemeralRunSpec) =>
      Effect.tryPromise(async () => {
        if (spec.command.includes("sqlite-bind-proof")) {
          proofPath = spec.command[5] ?? "";
          expect(spec.binds).toEqual([{ source: f.root, target: f.root, readOnly: true }]);
          expect(spec.user).toBe("0:0");
          expect(statSync(proofPath).mode & 0o777).toBe(0o600);
          expect(readFileSync(proofPath, "utf8")).toBe(spec.command[6] ?? "");
          const child = Bun.spawn([...spec.command], { stdout: "pipe", stderr: "pipe" });
          const [exitCode, stdout, stderr] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
          ]);
          return { exitCode, stdout, stderr };
        }
        statRuns++;
        expect(existsSync(proofPath)).toBe(false);
        return { exitCode: 0, stdout: "100:200\n", stderr: "" };
      }),
  };
  const helper = await Effect.runPromise(prepareSqliteHelper(deps, service, target));
  expect(statRuns).toBe(1);
  expect(readdirSync(f.root).some((name) => name.startsWith(".lando-sqlite-proof."))).toBe(false);
  await Effect.runPromise(removeSqliteHelperScratch(helper.scratchHost));
});

test("refuses a split helper bind view before any database ownership or SQLite access", async () => {
  for (const replica of ["missing", "wrong-token"]) {
    const f = setup();
    const remote = mkdtempSync(join(tmpdir(), "lando-sqlite-replica-"));
    directories.push(remote);
    const service: SqlPlanService = {
      ...f.service,
      mounts: [{ type: "bind", source: f.root, target: f.root, role: "app", readOnly: false }],
    };
    let statRuns = 0;
    const deps = {
      ...f,
      run: (spec: EphemeralRunSpec) =>
        Effect.tryPromise(async () => {
          if (!spec.command.includes("sqlite-bind-proof")) {
            statRuns++;
            return { exitCode: 0, stdout: "100:200\n", stderr: "" };
          }
          const command = [...spec.command];
          const replicaPath = join(remote, basename(command[5] ?? ""));
          command[5] = replicaPath;
          if (replica === "wrong-token")
            writeFileSync(replicaPath, "replicated content is not the host's current proof");
          const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
          const [exitCode, stdout, stderr] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
          ]);
          return { exitCode, stdout, stderr };
        }),
    };
    const exit = await Effect.runPromiseExit(prepareSqliteHelper(deps, service, f.target));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit))
      expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))).toBeInstanceOf(
        SqlRecoveryUnavailableError,
      );
    expect(statRuns).toBe(0);
    expect(readdirSync(f.root).some((name) => name.startsWith(".lando-sqlite-proof."))).toBe(false);
  }
});

test("fails closed on bind proof cleanup failure before inspecting the database", async () => {
  const f = setup();
  const service: SqlPlanService = {
    ...f.service,
    mounts: [{ type: "bind", source: f.root, target: f.root, role: "app", readOnly: false }],
  };
  let statRuns = 0;
  const exit = await Effect.runPromiseExit(
    prepareSqliteHelper(
      {
        ...f,
        run: (spec: EphemeralRunSpec) => {
          if (spec.command.includes("sqlite-bind-proof")) rmSync(spec.command[5] ?? "");
          else statRuns++;
          return Effect.succeed({ exitCode: 0, stdout: "100:200\n", stderr: "" });
        },
      },
      service,
      f.target,
    ),
  );
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit))
    expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))).toBeInstanceOf(
      SqlRecoveryUnavailableError,
    );
  expect(statRuns).toBe(0);
});

test("rejects a file-only bind source before launching a helper", async () => {
  const f = setup();
  const file = join(f.root, "file.sqlite");
  writeFileSync(file, "SQLite format 3\0");
  const service: SqlPlanService = {
    ...f.service,
    mounts: [{ type: "bind", source: file, target: "/app", role: "app", readOnly: false }],
  };
  let runs = 0;
  const exit = await Effect.runPromiseExit(
    prepareSqliteHelper(
      {
        ...f,
        run: () => {
          runs++;
          return Effect.succeed({ exitCode: 0, stdout: "100:200\n", stderr: "" });
        },
      },
      service,
      f.target,
    ),
  );
  expect(Exit.isFailure(exit)).toBe(true);
  expect(runs).toBe(0);
});

test("uses one canonical bind source for proof, stat, and the database helper", async () => {
  const f = setup();
  const alias = join(f.root, "alias");
  symlinkSync(f.root, alias);
  const service: SqlPlanService = {
    ...f.service,
    mounts: [{ type: "bind", source: alias, target: "/app", role: "app", readOnly: false }],
  };
  const runs: EphemeralRunSpec[] = [];
  const helper = await Effect.runPromise(
    prepareSqliteHelper(
      {
        ...f,
        run: (spec) => {
          runs.push(spec);
          return Effect.succeed({ exitCode: 0, stdout: "100:200\n", stderr: "" });
        },
      },
      service,
      f.target,
    ),
  );
  try {
    expect(runs).toHaveLength(2);
    for (const spec of runs) expect(spec.binds?.[0]?.source).toBe(realpathSync(f.root));
    expect(helper.covering).toMatchObject({ kind: "bind", source: realpathSync(f.root) });
    expect(helper.spec.binds?.[0]?.source).toBe(realpathSync(f.root));
  } finally {
    await Effect.runPromise(removeSqliteHelperScratch(helper.scratchHost));
  }
});

test("keeps subpath API requirements and remedies in user-visible SQLite errors", async () => {
  const f = setup();
  const capability = new ProviderCapabilityError({
    providerId: "docker",
    operation: "run.create",
    capability: "volume-subpath",
    requiredValue: "1.45",
    actualValue: "1.43",
    message: "Docker volume subdirectory helpers require API v1.45 or newer.",
    remediation:
      "Use a volume root or passthrough directory bind, or update Docker/Lando to use API v1.45 or newer.",
  });
  const deps = { ...f, run: () => Effect.fail(capability) };
  const inspected = await Effect.runPromiseExit(prepareSqliteHelper(deps, f.service, f.target));
  expect(Exit.isFailure(inspected)).toBe(true);
  if (!Exit.isFailure(inspected)) return;
  const error = Option.getOrUndefined(Cause.findErrorOption(inspected.cause));
  expect(error).toBeInstanceOf(SqlRecoveryUnavailableError);
  if (!(error instanceof SqlRecoveryUnavailableError)) return;
  expect(error.message).toContain("API v1.45");
  expect(error.remediation).toContain("volume root");
  expect(error.remediation).toContain("update Docker/Lando");
  const helper = await Effect.runPromise(
    prepareSqliteHelper(
      { ...f, run: () => Effect.succeed({ exitCode: 0, stdout: "100:200", stderr: "" }) },
      f.service,
      f.target,
    ),
  );
  try {
    const executed = await Effect.runPromiseExit(runSqliteHelper(deps, f.target, helper, ["true"]));
    expect(Exit.isFailure(executed)).toBe(true);
    if (!Exit.isFailure(executed)) return;
    const commandError = Option.getOrUndefined(Cause.findErrorOption(executed.cause));
    expect(commandError).toBeInstanceOf(SqlCommandFailedError);
    if (!(commandError instanceof SqlCommandFailedError)) return;
    expect(commandError.message).toContain("API v1.45");
    expect(commandError.remediation).toContain("volume root");
  } finally {
    await Effect.runPromise(removeSqliteHelperScratch(helper.scratchHost));
  }
});

test("exposes subpath version preflight guidance rather than only nested provider details", async () => {
  const f = setup();
  const failure = new ProviderUnavailableError({
    providerId: "docker",
    operation: "volume-subpath",
    message: "Docker volume subdirectory helpers require API v1.45 or newer; support is unverified.",
    remediation: "Use a volume root or a passthrough directory bind, or update the selected endpoint.",
  });
  const exit = await Effect.runPromiseExit(
    prepareSqliteHelper({ ...f, run: () => Effect.fail(failure) }, f.service, f.target),
  );
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) return;
  const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
  expect(error).toBeInstanceOf(SqlRecoveryUnavailableError);
  if (!(error instanceof SqlRecoveryUnavailableError)) return;
  expect(error.message).toContain("API v1.45");
  expect(error.remediation).toContain("volume root");
  expect(error.remediation).toContain("passthrough directory bind");
});
