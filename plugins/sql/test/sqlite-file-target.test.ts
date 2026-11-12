import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sqliteHelperImage } from "@lando/container-runtime/data-plane";
import {
  SqlCommandFailedError,
  SqlDumpIncompleteError,
  SqlRecoveryUnavailableError,
  SqlSeedSourceError,
} from "@lando/sdk/errors";
import { AbsolutePath, AppId, type AppPlan } from "@lando/sdk/schema";
import type { EphemeralRunSpec } from "@lando/sdk/services";
import { Cause, Effect, Exit, Option } from "effect";
import { dbInputFromCommand } from "../src/command-input.ts";
import { executeDbCommand } from "../src/run.ts";
import { packSqliteTar, unpackSqliteTar } from "../src/sqlite-archive.ts";
import { executeSqliteCommand } from "../src/sqlite-execute.ts";
import { isSqliteDatabaseHeader } from "../src/sqlite-header.ts";
import {
  prepareSqliteHelper,
  removeSqliteHelperScratch,
  requireSqliteDatabaseHeader,
  sqliteScratchFile,
  withSqliteHelper,
} from "../src/sqlite-helper.ts";
import {
  coveringSqliteMount,
  requireSqliteCoveringMount,
  sqliteContainerPath,
  sqliteHelperUser,
} from "../src/sqlite-mount.ts";
import { sqliteSidecarPaths, sqliteSnapshotStore } from "../src/sqlite-path.ts";
import { sqliteSnapshotVolume, sqliteSnapshotsCompatible } from "../src/sqlite-snapshot.ts";
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
  test("retains the original snapshot catalog app after an app rename", () => {
    expect(
      sqliteSnapshotVolume(
        {
          id: "renamed",
          name: "renamed",
          root: "/app",
          services: {},
          identity: { appRoot: "/app", ownerKey: "owner", dataName: "original" },
        },
        "data/site.sqlite",
      ),
    ).toEqual({ app: AppId.make("original"), store: sqliteSnapshotStore("data/site.sqlite") });
  });
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
    extensions: {},
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
      target: "/app/data",
      readOnly: false,
    });
  });

  test("refuses a SQLite path on a volume subpath", () => {
    const appService = service([
      { type: "bind", source: "/host/app", target: "/app", readOnly: false, role: "app" },
      { type: "volume", store: "appserver_data", target: "/app/data", readOnly: false, subpath: "inner" },
    ]);
    const refused = requireSqliteCoveringMount(appService, target);
    expect(refused).toBeInstanceOf(SqlRecoveryUnavailableError);
    if (refused instanceof SqlRecoveryUnavailableError) expect(refused.message).toContain("volume subpath");
  });

  test("identifies tmpfs covering mounts", () => {
    expect(
      coveringSqliteMount(service([{ type: "tmpfs", target: "/app/data" }]), "/app/data/site.sqlite"),
    ).toEqual({ kind: "tmpfs", target: "/app/data" });
  });
});

describe("sqlite snapshot compatibility", () => {
  test("keys on canonical owner, archive format, service, and path with version as provenance", () => {
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
        path: "data/site.sqlite",
        family: "sqlite",
        version: "3.54.1",
        recoveryReason: "manual" as const,
      },
    };
    expect(
      sqliteSnapshotsCompatible({ ...source, metadata: { ...source.metadata, version: "3.45.0" } } as never, {
        ownerKey: "abc",
        appRoot: "/app",
        service: "appserver",
        path: "data/site.sqlite",
      }),
    ).toBe(true);
    expect(
      sqliteSnapshotsCompatible(source as never, {
        ownerKey: "abc",
        appRoot: "/app",
        service: "appserver",
        path: "data/site.sqlite",
      }),
    ).toBe(true);
    for (const overrides of [
      { owner: { ...source.owner, appRoot: "/other" } },
      { store: { app: "app", store: "other-store" } },
      { format: "tar.gz" },
      { metadata: { ...source.metadata, service: "other" } },
    ]) {
      expect(
        sqliteSnapshotsCompatible({ ...source, ...overrides } as never, {
          ownerKey: "abc",
          appRoot: "/app",
          service: "appserver",
          path: "data/site.sqlite",
        }),
      ).toBe(false);
    }
    expect(
      sqliteSnapshotsCompatible(source as never, {
        ownerKey: "abc",
        appRoot: "/app",
        service: "appserver",
        path: "other.sqlite",
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

describe("sqlite seed", () => {
  afterEach(cleanupSqlTestDeps);

  test("fails closed because seed is volume initialization, not a file target", async () => {
    const harness = makeSqlTestDeps({ password: "secret" });
    const database = harness.deps.plan.services.database;
    if (database === undefined) throw new Error("expected database service");
    const { connection: _connection, nonSqlCreds: _nonSqlCreds, ...fileService } = database;
    const deps = {
      ...harness.deps,
      plan: {
        ...harness.deps.plan,
        services: {
          ...harness.deps.plan.services,
          database: { ...fileService, type: "php:8.3", sqlite: { path: "data/site.sqlite" } },
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
  test("pins alpine/sqlite by tag and digest", () => {
    expect(sqliteHelperImage.digest).toBe(
      "sha256:c60da9273ce8d15e63b6a536383ba07cdb053dac02c04cbe11e4072938d40a75",
    );
    expect(sqliteHelperImage.ref).toBe(`docker.io/alpine/sqlite:3.53.4@${sqliteHelperImage.digest}`);
    expect(sqliteHelperImage.ref).toContain("@sha256:");
  });

  test("accepts verified numeric ownership without falling back to the host identity", () => {
    expect(sqliteHelperUser("100:200\n")).toBe("100:200");
    expect(sqliteHelperUser("0:0")).toBe("0:0");
    for (const invalid of ["", "www-data", "-1:100", "100:200:300", "100:200\n0:0", "9007199254740992:1"]) {
      expect(sqliteHelperUser(invalid)).toBeUndefined();
    }
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
      extensions: {},
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
      inspect: () => Effect.succeed({ status: "running" as const, running: true, containerId: "service" }),
      privateFileAccess: { enforce: async () => undefined, verify: async () => undefined },
      run: () => Effect.succeed({ exitCode: 0, stdout: "100:200\n", stderr: "" }),
      pullArtifact: () => Effect.succeed({ digest: sqliteHelperImage.digest }),
      paths: {
        snapshotsDir: join(dataRoot, "snapshots"),
        ownerSnapshotsDir: (key: string) => join(dataRoot, "snapshots", key),
      },
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
      extensions: {},
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
      inspect: () => Effect.succeed({ status: "running" as const, running: true, containerId: "service" }),
      privateFileAccess: { enforce: async () => undefined, verify: async () => undefined },
      run: () => Effect.succeed({ exitCode: 0, stdout: "100:200\n", stderr: "" }),
      pullArtifact: () => Effect.succeed({ digest: sqliteHelperImage.digest }),
      paths: {
        snapshotsDir: join(dataRoot, "snapshots"),
        ownerSnapshotsDir: (key: string) => join(dataRoot, "snapshots", key),
      },
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

  test.each([
    "failure",
    "empty",
    "truncated",
    "no-pragmas",
    "none",
    "gzip",
    "zstd",
    "file-none",
    "file-gzip",
    "file-zstd",
  ] as const)("exports SQLite dump with %s output", async (mode) => {
    const harness = makeSqlTestDeps({ password: "secret", initiallyRunning: false });
    mkdirSync(join(harness.root, "data"));
    const dataRoot = join(harness.root, "export-state");
    const payload =
      "BEGIN TRANSACTION;\nCREATE TABLE t (id INTEGER);\nCOMMIT;\nPRAGMA user_version=7;\nPRAGMA application_id=0;\n";
    const fileOutput = mode.startsWith("file-");
    const failing = mode === "failure" || mode === "empty" || mode === "truncated" || mode === "no-pragmas";
    const destination = join(
      harness.root,
      mode === "file-gzip" ? "dump.sql.gz" : mode === "file-zstd" ? "dump.sql.zst" : "dump.sql",
    );
    writeFileSync(destination, "previous dump");
    const originalInode = statSync(destination).ino;
    const chunks: Uint8Array[] = [];
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
            extensions: {},
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
        inspect: harness.deps.inspect,
        privateFileAccess: harness.deps.privateFileAccess,
        run: (spec: EphemeralRunSpec) => {
          commands.push(spec.command);
          if (spec.command.includes("sqlite-owner")) {
            return Effect.succeed({ exitCode: 0, stdout: "100:200\n", stderr: "" });
          }
          if (mode !== "failure") {
            const output = spec.command.at(-1);
            const bind = spec.binds?.find((bind) => output?.startsWith(`${bind.target}/`));
            if (output === undefined || bind === undefined) throw new Error("Missing dump scratch bind");
            writeFileSync(
              join(bind.source, output.slice(bind.target.length)),
              mode === "empty"
                ? ""
                : mode === "truncated"
                  ? payload.slice(0, payload.indexOf("COMMIT;"))
                  : mode === "no-pragmas"
                    ? payload.slice(0, payload.indexOf("PRAGMA"))
                    : payload,
            );
            return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });
          }
          return Effect.succeed({
            exitCode: 1,
            stdout: "",
            stderr: "Error: unable to open database file\n",
          });
        },
        pullArtifact: () => Effect.succeed({ digest: sqliteHelperImage.digest }),
        paths: {
          snapshotsDir: join(dataRoot, "snapshots"),
          ownerSnapshotsDir: (key: string) => join(dataRoot, "snapshots", key),
        },
        stateStore: {
          open: () => Effect.die("unused"),
          withLock: <A, E>(_key: string, body: Effect.Effect<A, E>) => body,
        },
      },
    };
    const exit = await Effect.runPromiseExit(
      executeSqliteCommand(
        deps,
        failing
          ? { action: "export", yes: true, file: join(harness.root, "dump.sql") }
          : {
              action: "export",
              yes: true,
              file: fileOutput ? destination : "-",
              ...(mode === "none" || mode === "gzip" || mode === "zstd" ? { compression: mode } : {}),
              stdio: {
                stdout: (chunk) =>
                  Effect.sync(() => {
                    chunks.push(chunk);
                  }),
              },
            },
        {
          kind: "file",
          name: "appserver",
          type: "php:8.3",
          family: "sqlite",
          path: "data/site.sqlite",
        },
      ),
    );
    const dumpScript = commands.find((command) => command.includes("sqlite-dump"))?.[2] ?? "";
    expect(dumpScript).toContain('".dump --preserve-rowids"');
    // The header pragmas follow the dump so its defensive-mode comment stays the first line.
    expect(dumpScript.indexOf(".dump")).toBeLessThan(dumpScript.indexOf("PRAGMA user_version="));
    expect(dumpScript).toContain("PRAGMA application_id=");
    if (!failing) {
      expect(Exit.isSuccess(exit)).toBe(true);
      const bytes = fileOutput
        ? Buffer.from(await Bun.file(destination).arrayBuffer())
        : Buffer.concat(chunks);
      const plain =
        mode === "gzip" || mode === "file-gzip"
          ? Bun.gunzipSync(bytes)
          : mode === "zstd" || mode === "file-zstd"
            ? Bun.zstdDecompressSync(bytes)
            : bytes;
      expect(new TextDecoder().decode(plain)).toBe(payload);
      if (fileOutput) expect(statSync(destination).ino).not.toBe(originalInode);
      if (Exit.isSuccess(exit)) expect(exit.value.sizeBytes).toBe(bytes.byteLength);
      expect(existsSync(join(harness.root, "-"))).toBe(false);
      return;
    }
    expect(Exit.isFailure(exit)).toBe(true);
    expect(await Bun.file(destination).text()).toBe("previous dump");
    if (!Exit.isFailure(exit)) return;
    const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
    if (mode !== "failure") {
      expect(error).toBeInstanceOf(SqlDumpIncompleteError);
      if (error instanceof SqlDumpIncompleteError)
        expect(error.reason).toBe(mode === "empty" ? "empty" : "truncated");
      return;
    }
    expect(error).toBeInstanceOf(SqlCommandFailedError);
    if (!(error instanceof SqlCommandFailedError)) return;
    expect(error.stderrTail).toContain("unable to open database file");
  });
});

describe("sqlite command input", () => {
  test("does not map unsupported --force from command input", () => {
    expect(
      dbInputFromCommand("import", {
        argv: [],
        parsedArgv: [],
        flags: { force: true, yes: true },
        args: { file: "dump.sql" },
      }),
    ).toEqual({ action: "import", yes: true, file: "dump.sql", hostCwd: process.cwd() });
  });
});
