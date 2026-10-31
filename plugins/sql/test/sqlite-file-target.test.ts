import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit, Option } from "effect";

import { sqliteHelperImage } from "@lando/container-runtime/data-plane";
import { SqlCommandFailedError, SqlRecoveryUnavailableError, SqlSeedSourceError } from "@lando/sdk/errors";
import { AbsolutePath, type AppPlan } from "@lando/sdk/schema";
import type { EphemeralRunSpec } from "@lando/sdk/services";
import { dbInputFromCommand } from "../src/command-input.ts";
import { executeDbCommand } from "../src/run.ts";
import { packSqliteTar, unpackSqliteTar } from "../src/sqlite-archive.ts";
import { executeSqliteCommand } from "../src/sqlite-execute.ts";
import { isSqliteDatabaseHeader } from "../src/sqlite-header.ts";
import {
  prepareSqliteHelper,
  prepareSqliteScratchDir,
  removeSqliteHelperScratch,
  requireSqliteDatabaseHeader,
  sqliteScratchFile,
  withSqliteHelper,
} from "../src/sqlite-helper.ts";
import { coveringSqliteMount, sqliteContainerPath, sqliteHelperUser } from "../src/sqlite-mount.ts";
import { sqliteSidecarPaths, sqliteSnapshotStore } from "../src/sqlite-path.ts";
import { sqliteSnapshotsCompatible } from "../src/sqlite-snapshot.ts";
import { overlaySqliteFromLandofile } from "../src/views.ts";
import type { SqlPlanService } from "../src/views.ts";
import { cleanupSqlTestDeps, makeSqlTestDeps } from "./support/fakes.ts";

const header = new TextEncoder().encode("SQLite format 3\0more");

describe("sqlite header detection", () => {
  test("accepts the 16-byte SQLite format 3 header", () => {
    expect(isSqliteDatabaseHeader(header)).toBe(true);
    expect(isSqliteDatabaseHeader(new TextEncoder().encode("SQLite format 3"))).toBe(false);
    expect(isSqliteDatabaseHeader(new TextEncoder().encode("CREATE TABLE t (id int);"))).toBe(false);
  });
});

describe("sqlite sidecars and store names", () => {
  test("names wal, shm, and journal sidecars next to the database path", () => {
    expect(sqliteSidecarPaths("/app/data/site.sqlite")).toEqual([
      "/app/data/site.sqlite-wal",
      "/app/data/site.sqlite-shm",
      "/app/data/site.sqlite-journal",
    ]);
  });

  test("hashes the relative path into a hex-only snapshot store name", () => {
    const store = sqliteSnapshotStore("data/site.sqlite");
    expect(store.startsWith("sqlite-")).toBe(true);
    expect(store).toMatch(/^sqlite-[0-9a-f]{32}$/u);
    expect(sqliteSnapshotStore("data/other.sqlite")).not.toBe(store);
  });
});

describe("covering sqlite mounts", () => {
  const service = (mounts: SqlPlanService["mounts"]): SqlPlanService => ({
    name: "appserver",
    type: "php:8.3",
    environment: {},
    mounts,
    storage: [],
  });
  const target = {
    kind: "file" as const,
    name: "appserver",
    type: "php:8.3",
    family: "sqlite" as const,
    path: "data/site.sqlite",
  };

  test("joins sqlite.path onto the app mount", () => {
    expect(
      sqliteContainerPath(
        service([{ type: "bind", source: "/host/app", target: "/app", readOnly: false, role: "app" }]),
        target,
      ),
    ).toBe("/app/data/site.sqlite");
  });

  test("selects the deepest exclude volume over the parent app bind", () => {
    const covering = coveringSqliteMount(
      service([
        { type: "bind", source: "/host/app", target: "/app", readOnly: false, role: "app" },
        { type: "volume", store: "appserver_data", target: "/app/data", readOnly: false },
      ]),
      "/app/data/site.sqlite",
    );
    expect(covering).toEqual({
      kind: "volume",
      store: "appserver_data",
      target: "/app/data",
      readOnly: false,
    });
  });

  test("rejects tmpfs covering mounts", () => {
    expect(
      coveringSqliteMount(service([{ type: "tmpfs", target: "/app/data" }]), "/app/data/site.sqlite"),
    ).toEqual({ kind: "tmpfs", target: "/app/data" });
  });
});

describe("sqlite snapshot compatibility", () => {
  test("keys on sqlite_version, canonical owner, archive format, service, and path", () => {
    const source = {
      owner: { appRoot: "/app", ownerKey: "abc" },
      id: "snap",
      store: { app: "app", store: sqliteSnapshotStore("data/site.sqlite") },
      format: "tar",
      digest: "d".repeat(64),
      sizeBytes: 1,
      createdAt: "2026-01-01T00:00:00.000Z" as never,
      metadata: {
        service: "appserver",
        volumeInstanceId: "data/site.sqlite",
        family: "sqlite",
        version: "3.54.1",
        imageIdentity: "sqlite",
        recoveryReason: "manual" as const,
      },
    };
    expect(
      sqliteSnapshotsCompatible(source as never, {
        ownerKey: "abc",
        appRoot: "/app",
        service: "appserver",
        path: "data/site.sqlite",
        version: "3.54.1",
      }),
    ).toBe(true);
    expect(
      sqliteSnapshotsCompatible(source as never, {
        ownerKey: "abc",
        appRoot: "/app",
        service: "appserver",
        path: "data/site.sqlite",
        version: "3.45.0",
      }),
    ).toBe(false);
    for (const overrides of [
      { owner: { ...source.owner, appRoot: "/other" } },
      { store: { app: "app", store: "other-store" } },
      { format: "tar.gz" },
      { metadata: { ...source.metadata, imageIdentity: "other" } },
    ]) {
      expect(
        sqliteSnapshotsCompatible({ ...source, ...overrides } as never, {
          ownerKey: "abc",
          appRoot: "/app",
          service: "appserver",
          path: "data/site.sqlite",
          version: "3.54.1",
        }),
      ).toBe(false);
    }
    expect(
      sqliteSnapshotsCompatible(source as never, {
        ownerKey: "abc",
        appRoot: "/app",
        service: "appserver",
        path: "other.sqlite",
        version: "3.54.1",
      }),
    ).toBe(false);
  });
});

describe("sqlite archive packing", () => {
  test("round-trips a SQLite payload through a single-file tar", () => {
    const packed = packSqliteTar(header);
    const unpacked = unpackSqliteTar(packed);
    expect(unpacked).toEqual(header);
    expect(isSqliteDatabaseHeader(unpacked ?? new Uint8Array())).toBe(true);
  });
});

describe("landofile sqlite overlay", () => {
  test("copies authored sqlite onto an applied plan service before rebuild", () => {
    const overlaid = overlaySqliteFromLandofile(
      {
        id: "app",
        name: "app",
        root: "/app",
        services: {
          appserver: {
            name: "appserver",
            type: "php:8.3",
            environment: {},
            mounts: [],
            storage: [],
          },
        },
      },
      { services: { appserver: { type: "php:8.3", sqlite: { path: "data/site.sqlite" } } } },
    );
    expect(overlaid.services.appserver?.sqlite).toEqual({ path: "data/site.sqlite" });
  });
});

describe("sqlite seed", () => {
  afterEach(cleanupSqlTestDeps);

  test("fails closed because seed is volume initialization, not a file target", async () => {
    const harness = makeSqlTestDeps({ password: "secret" });
    const database = harness.deps.plan.services.database;
    if (database === undefined) throw new Error("expected database service");
    const deps = {
      ...harness.deps,
      plan: {
        ...harness.deps.plan,
        services: {
          ...harness.deps.plan.services,
          database: { ...database, sqlite: { path: "data/site.sqlite" } },
        },
      },
    };
    const exit = await Effect.runPromiseExit(
      executeDbCommand(deps, {
        action: "seed",
        yes: true,
        file: "dump.sql",
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) return;
    const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
    expect(error).toBeInstanceOf(SqlSeedSourceError);
    if (!(error instanceof SqlSeedSourceError)) return;
    expect(error.sourceFamily).toBe("sqlite");
    expect(error.message).toContain("not supported");
  });
});

describe("sqlite helper user and scratch", () => {
  test("pins keinos/sqlite3 by tag and digest", () => {
    expect(sqliteHelperImage.digest).toBe(
      "sha256:b577e65892c6468d94b390097eda4488e05253470c161bdea68a05abb961fa17",
    );
    expect(sqliteHelperImage.ref).toBe(`docker.io/keinos/sqlite3:3.54.1@${sqliteHelperImage.digest}`);
    expect(sqliteHelperImage.ref).toContain("@sha256:");
  });

  test("accepts verified numeric ownership without falling back to the host identity", () => {
    expect(sqliteHelperUser("100:200\n")).toBe("100:200");
    expect(sqliteHelperUser("0:0")).toBe("0:0");
    for (const invalid of ["", "www-data", "-1:100", "100:200:300", "100:200\n0:0", "9007199254740992:1"]) {
      expect(sqliteHelperUser(invalid)).toBeUndefined();
    }
  });

  test("keeps Lando as scratch owner and stays writable when helper uid cannot be chowned", () => {
    const parent = mkdtempSync(join(tmpdir(), "lando-sqlite-scratch-"));
    const scratch = join(parent, "op");
    const processUid = process.getuid?.() ?? 0;
    const processGid = process.getgid?.() ?? 0;
    prepareSqliteScratchDir(scratch, `${processUid}:${processGid}`);
    writeFileSync(join(scratch, "same-uid"), "ok");
    const foreignUid = processUid === 65534 ? 65533 : 65534;
    const foreignGid = processGid === 65534 ? 65533 : 65534;
    const foreign = join(parent, "foreign");
    prepareSqliteScratchDir(foreign, `${foreignUid}:${foreignGid}`);
    const info = statSync(foreign);
    writeFileSync(join(foreign, "lando-owned"), "ok");
    if (processUid === 0) {
      expect(info.uid).toBe(foreignUid);
      expect(info.gid).toBe(foreignGid);
      return;
    }
    expect(info.uid).toBe(processUid);
    const mode = info.mode & 0o7777;
    expect(mode === 0o1777 || mode === 0o2770).toBe(true);
  });

  test("rejects VACUUM INTO output that is not a SQLite database", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lando-sqlite-vacuum-"));
    const missingHeader = join(dir, "empty.sqlite");
    writeFileSync(missingHeader, "not a database");
    const exit = await Effect.runPromiseExit(
      requireSqliteDatabaseHeader(
        missingHeader,
        "appserver",
        "VACUUM INTO did not produce a SQLite database.",
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) return;
    const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
    expect(error).toBeInstanceOf(SqlRecoveryUnavailableError);
    if (!(error instanceof SqlRecoveryUnavailableError)) return;
    expect(error.message).toContain("VACUUM INTO");
    expect(error.reason).toContain("SQLite format 3");
    const valid = join(dir, "ok.sqlite");
    writeFileSync(valid, header);
    await Effect.runPromise(requireSqliteDatabaseHeader(valid, "appserver", "ok"));
  });

  test("always passes a numeric user and isolates scratch under owner snapshots", async () => {
    const bind = mkdtempSync(join(tmpdir(), "lando-sqlite-app-"));
    mkdirSync(join(bind, "data"));
    const dataRoot = mkdtempSync(join(tmpdir(), "lando-sqlite-data-"));
    const ownerKey = "owner-key";
    const applied = {
      id: "app",
      root: AbsolutePath.make(bind),
      identity: { appRoot: AbsolutePath.make(bind), ownerKey },
    } as AppPlan;
    const service: SqlPlanService = {
      name: "appserver",
      type: "php:8.3",
      environment: {},
      user: "www-data",
      sqlite: { path: "data/site.sqlite" },
      mounts: [{ type: "bind", source: bind, target: "/app", readOnly: false, role: "app" }],
      storage: [],
    };
    const target = {
      kind: "file" as const,
      name: "appserver",
      type: "php:8.3",
      family: "sqlite" as const,
      path: "data/site.sqlite",
    };
    const deps = {
      applied,
      run: () => Effect.succeed({ exitCode: 0, stdout: "100:200\n", stderr: "" }),
      pullArtifact: () => Effect.succeed({ digest: sqliteHelperImage.digest }),
      paths: { ownerSnapshotsDir: (key: string) => join(dataRoot, "snapshots", key) },
    };
    const first = await Effect.runPromise(prepareSqliteHelper(deps, service, target));
    const second = await Effect.runPromise(prepareSqliteHelper(deps, service, target));
    const expectedUser = "100:200";
    expect(first.user).toBe(expectedUser);
    expect(first.spec.user).toBe(expectedUser);
    expect(first.spec.user).not.toBe("www-data");
    expect(first.scratchHost).not.toBe(second.scratchHost);
    expect(first.scratchHost).toContain(join(dataRoot, "snapshots", ownerKey, "sqlite-helper"));
    expect(second.scratchHost).toContain(join(dataRoot, "snapshots", ownerKey, "sqlite-helper"));
    await Effect.runPromise(removeSqliteHelperScratch(first.scratchHost));
    await Effect.runPromise(removeSqliteHelperScratch(second.scratchHost));
  });

  test("uses unique scratch file names and removes the per-op directory after the helper body", async () => {
    const bind = mkdtempSync(join(tmpdir(), "lando-sqlite-app-"));
    mkdirSync(join(bind, "data"));
    const dataRoot = mkdtempSync(join(tmpdir(), "lando-sqlite-data-"));
    const applied = {
      id: "app",
      root: AbsolutePath.make(bind),
      identity: { appRoot: AbsolutePath.make(bind), ownerKey: "owner-key" },
    } as AppPlan;
    const service: SqlPlanService = {
      name: "appserver",
      type: "php:8.3",
      environment: {},
      sqlite: { path: "data/site.sqlite" },
      mounts: [{ type: "bind", source: bind, target: "/app", readOnly: false, role: "app" }],
      storage: [],
    };
    const target = {
      kind: "file" as const,
      name: "appserver",
      type: "php:8.3",
      family: "sqlite" as const,
      path: "data/site.sqlite",
    };
    const deps = {
      applied,
      run: () => Effect.succeed({ exitCode: 0, stdout: "100:200\n", stderr: "" }),
      pullArtifact: () => Effect.succeed({ digest: sqliteHelperImage.digest }),
      paths: { ownerSnapshotsDir: (key: string) => join(dataRoot, "snapshots", key) },
    };
    const observed = await Effect.runPromise(
      withSqliteHelper(deps, service, target, (helper) =>
        Effect.sync(() => {
          const first = sqliteScratchFile(helper, ".sqlite");
          const second = sqliteScratchFile(helper, ".sqlite");
          expect(first.name).not.toBe(second.name);
          expect(first.host.startsWith(helper.scratchHost)).toBe(true);
          expect(existsSync(helper.scratchHost)).toBe(true);
          return helper.scratchHost;
        }),
      ),
    );
    expect(existsSync(observed)).toBe(false);
  });
});

describe("sqlite export dump", () => {
  afterEach(cleanupSqlTestDeps);

  test("fails dump with -bail and attaches helper stderr", async () => {
    const harness = makeSqlTestDeps({ password: "secret", initiallyRunning: false });
    mkdirSync(join(harness.root, "data"));
    const dataRoot = mkdtempSync(join(tmpdir(), "lando-sqlite-export-"));
    const commands: Array<ReadonlyArray<string>> = [];
    const applied = {
      id: "app",
      root: AbsolutePath.make(harness.root),
      identity: { appRoot: AbsolutePath.make(harness.root), ownerKey: "owner-key" },
    } as AppPlan;
    const deps = {
      ...harness.deps,
      plan: {
        ...harness.deps.plan,
        services: {
          appserver: {
            name: "appserver",
            type: "php:8.3",
            environment: {},
            sqlite: { path: "data/site.sqlite" },
            mounts: [
              {
                type: "bind" as const,
                source: harness.root,
                target: "/app",
                readOnly: false,
                role: "app" as const,
              },
            ],
            storage: [],
          },
        },
      },
      sqlite: {
        applied,
        run: (spec: EphemeralRunSpec) => {
          commands.push(spec.command);
          if (spec.command.includes("sqlite-owner")) {
            return Effect.succeed({ exitCode: 0, stdout: "100:200\n", stderr: "" });
          }
          return Effect.succeed({
            exitCode: 1,
            stdout: "",
            stderr: "Error: unable to open database file\n",
          });
        },
        pullArtifact: () => Effect.succeed({ digest: sqliteHelperImage.digest }),
        paths: { ownerSnapshotsDir: (key: string) => join(dataRoot, "snapshots", key) },
        stateStore: {
          open: () => Effect.die("unused"),
          withLock: <A, E>(_key: string, body: Effect.Effect<A, E>) => body,
        },
      },
    };
    const exit = await Effect.runPromiseExit(
      executeSqliteCommand(
        deps,
        { action: "export", yes: true, file: join(harness.root, "dump.sql") },
        {
          kind: "file",
          name: "appserver",
          type: "php:8.3",
          family: "sqlite",
          path: "data/site.sqlite",
        },
      ),
    );
    expect(
      commands.some((command) => command.includes('sqlite3 -bail -readonly -ifexists "$1" .dump > "$2"')),
    ).toBe(true);
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) return;
    const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
    expect(error).toBeInstanceOf(SqlCommandFailedError);
    if (!(error instanceof SqlCommandFailedError)) return;
    expect(error.stderrTail).toContain("unable to open database file");
  });
});

describe("sqlite live writer guard", () => {
  afterEach(cleanupSqlTestDeps);

  const sqliteDeps = (running: boolean) => {
    const harness = makeSqlTestDeps({ password: "secret", initiallyRunning: running });
    return {
      harness,
      deps: {
        ...harness.deps,
        plan: {
          ...harness.deps.plan,
          services: {
            appserver: {
              name: "appserver",
              type: "php:8.3",
              environment: {},
              sqlite: { path: "data/site.sqlite" },
              mounts: [
                {
                  type: "bind" as const,
                  source: harness.root,
                  target: "/app",
                  readOnly: false,
                  role: "app" as const,
                },
              ],
              storage: [],
            },
          },
        },
      },
    };
  };

  test("refuses import while the owning service is running", async () => {
    const { deps } = sqliteDeps(true);
    const exit = await Effect.runPromiseExit(
      executeDbCommand(deps, { action: "import", yes: true, file: "dump.sql" }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) return;
    const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
    expect(error).toBeInstanceOf(SqlRecoveryUnavailableError);
    if (!(error instanceof SqlRecoveryUnavailableError)) return;
    expect(error.message).toContain("while the service is running");
    expect(error.remediation).toContain("--force");
    expect(error.remediation).toContain("Stop the service");
  });

  test("refuses restore and reset while the owning service is running", async () => {
    for (const action of ["restore", "reset"] as const) {
      const { deps } = sqliteDeps(true);
      const exit = await Effect.runPromiseExit(
        executeDbCommand(deps, { action, yes: true, snapshotId: "snap" }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (!Exit.isFailure(exit)) continue;
      const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
      expect(error).toBeInstanceOf(SqlRecoveryUnavailableError);
      if (!(error instanceof SqlRecoveryUnavailableError)) continue;
      expect(error.message).toContain("while the service is running");
    }
  });

  test("refuses a running service even when --force and --yes are set", async () => {
    const { harness, deps } = sqliteDeps(true);
    const exit = await Effect.runPromiseExit(
      executeDbCommand(deps, Object.assign({ action: "reset" as const, yes: true }, { force: true })),
    );
    expect(harness.published()).not.toContain("message.warn");
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) return;
    const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
    expect(error).toBeInstanceOf(SqlRecoveryUnavailableError);
    if (error instanceof SqlRecoveryUnavailableError) {
      expect(error.remediation).toContain("do not bypass safety checks");
    }
  });

  test("does not map unsupported --force from command input", () => {
    expect(
      dbInputFromCommand("import", {
        argv: [],
        parsedArgv: [],
        flags: { force: true, yes: true },
        args: { file: "dump.sql" },
      }),
    ).toMatchObject({ action: "import", yes: true, file: "dump.sql" });
  });
});
