import { chmodSync, mkdirSync, mkdtempSync, statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";
import { Cause, DateTime, Effect, Exit, Layer, Option } from "effect";

import { sqliteHelperImage } from "@lando/container-runtime/data-plane";
import { makeLandoPaths } from "@lando/paths";
import {
  SqlCommandFailedError,
  SqlRecoveryOperationError,
  SqlRecoveryUnavailableError,
  StateStoreError,
} from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  SnapshotInfo,
  planAppIdentity,
} from "@lando/sdk/schema";
import type { EphemeralRunSpec, ExecResult, StateStoreShape } from "@lando/sdk/services";
import { PathsService, StateStore } from "@lando/sdk/services";
import * as DiskStateStore from "@lando/state-store/service";

import type { SqlCommandDeps } from "../src/command-types.ts";
import { packSqliteTar, unpackSqliteTar } from "../src/sqlite-archive.ts";
import { executeSqliteCommand } from "../src/sqlite-execute.ts";
import { isSqliteDatabaseHeader } from "../src/sqlite-header.ts";
import { sqliteSnapshotStore } from "../src/sqlite-path.ts";
import { cleanupSqlTestDeps, makeSqlTestDeps } from "./support/fakes.ts";

const socket = process.env.LANDO_TEST_DOCKER_SOCKET || undefined;
const dockerHost =
  socket === undefined ? undefined : socket.startsWith("unix://") ? socket : `unix://${socket}`;

const dockerEnv = dockerHost === undefined ? process.env : { ...process.env, DOCKER_HOST: dockerHost };

const docker = async (
  args: ReadonlyArray<string>,
  options?: { readonly cwd?: string; readonly stdin?: AsyncIterable<Uint8Array> | string },
) => {
  const stdin =
    options?.stdin === undefined
      ? "ignore"
      : typeof options.stdin === "string"
        ? new TextEncoder().encode(options.stdin)
        : new ReadableStream<Uint8Array>({
            async start(controller) {
              for await (const chunk of options.stdin as AsyncIterable<Uint8Array>) controller.enqueue(chunk);
              controller.close();
            },
          });
  const command =
    args[0] === "run" && options?.stdin !== undefined ? ["run", "-i", ...args.slice(1)] : [...args];
  const proc = Bun.spawn(["docker", ...command], {
    ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
    env: dockerEnv,
    stdin,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
};

const runEphemeral = (spec: EphemeralRunSpec): Effect.Effect<ExecResult, unknown> =>
  Effect.tryPromise(async () => {
    const args = ["run", "--rm", "--network", "none", "--entrypoint", ""];
    if (spec.user !== undefined) args.push("--user", spec.user);
    for (const bind of spec.binds ?? []) {
      args.push("-v", `${bind.source}:${bind.target}${bind.readOnly === true ? ":ro" : ""}`);
    }
    // This test adapter mounts planned names directly; production volume ownership checks
    // remain the provider's responsibility and are covered by its contract tests.
    for (const mount of spec.mounts ?? []) {
      const options = ["type=volume", `src=${mount.store}`, `dst=${mount.target}`];
      if (mount.readOnly) options.push("readonly");
      if (mount.subpath !== undefined) options.push(`volume-subpath=${mount.subpath}`);
      args.push("--mount", options.join(","));
    }
    if (spec.stdinStream !== undefined) args.push("-i");
    args.push(spec.image, ...spec.command);
    const result = await docker(args, {
      ...(spec.stdinStream === undefined ? {} : { stdin: spec.stdinStream }),
    });
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  });

test.skipIf(dockerHost === undefined)(
  `sqlite helper import/export/snapshot/restore round trip${dockerHost === undefined ? " (SKIP: LANDO_TEST_DOCKER_SOCKET required)" : ""}`,
  async () => {
    if (dockerHost === undefined) throw new Error("LANDO_TEST_DOCKER_SOCKET required");
    const dir = await mkdtemp(join(tmpdir(), "lando-sqlite-it-"));
    try {
      const pull = await docker(["pull", sqliteHelperImage.ref]);
      expect(pull.exitCode).toBe(0);

      const sql =
        "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO items (name) VALUES ('ok');";
      const hostUser = `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`;
      const create = await docker(
        [
          "run",
          "--rm",
          "--user",
          hostUser,
          "--entrypoint",
          "sqlite3",
          "-v",
          `${dir}:/data`,
          sqliteHelperImage.ref,
          "/data/app.sqlite",
        ],
        { stdin: sql },
      );
      expect(create.exitCode).toBe(0);

      const header = new Uint8Array(await Bun.file(join(dir, "app.sqlite")).arrayBuffer()).subarray(0, 16);
      expect(isSqliteDatabaseHeader(header)).toBe(true);

      const dumped = await docker([
        "run",
        "--rm",
        "--user",
        hostUser,
        "--entrypoint",
        "sqlite3",
        "-v",
        `${dir}:/data`,
        sqliteHelperImage.ref,
        "/data/app.sqlite",
        ".dump",
      ]);
      expect(dumped.exitCode).toBe(0);
      expect(dumped.stdout).toContain("CREATE TABLE items");

      const vacuum = await docker([
        "run",
        "--rm",
        "--user",
        hostUser,
        "--entrypoint",
        "sqlite3",
        "-v",
        `${dir}:/data`,
        sqliteHelperImage.ref,
        "/data/app.sqlite",
        "VACUUM INTO '/data/snap.sqlite';",
      ]);
      expect(vacuum.exitCode).toBe(0);

      const snapshotBytes = new Uint8Array(await Bun.file(join(dir, "snap.sqlite")).arrayBuffer());
      expect(isSqliteDatabaseHeader(snapshotBytes)).toBe(true);
      const archive = packSqliteTar(snapshotBytes);
      const restored = unpackSqliteTar(archive);
      expect(restored).toEqual(snapshotBytes);
      await writeFile(join(dir, "restored.sqlite"), restored ?? new Uint8Array());

      const count = await docker([
        "run",
        "--rm",
        "--user",
        hostUser,
        "--entrypoint",
        "sqlite3",
        "-v",
        `${dir}:/data`,
        sqliteHelperImage.ref,
        "/data/restored.sqlite",
        "SELECT name FROM items;",
      ]);
      expect(count.exitCode).toBe(0);
      expect(count.stdout.trim()).toBe("ok");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  240_000,
);

test.skipIf(dockerHost === undefined)(
  `executeSqliteCommand through a provider with a non-root app uid${dockerHost === undefined ? " (SKIP: LANDO_TEST_DOCKER_SOCKET required)" : ""}`,
  async () => {
    if (dockerHost === undefined) throw new Error("LANDO_TEST_DOCKER_SOCKET required");
    const hostUid = process.getuid?.() ?? 0;
    const hostGid = process.getgid?.() ?? 0;
    const appUid = hostUid === 1001 ? 1002 : 1001;
    const appGid = hostGid === 1001 ? 1002 : 1001;
    const appDir = mkdtempSync(join(tmpdir(), "lando-sqlite-provider-app-"));
    const landoRoot = mkdtempSync(join(tmpdir(), "lando-sqlite-provider-data-"));
    mkdirSync(join(appDir, "data"), { recursive: true });
    chmodSync(appDir, 0o755);
    chmodSync(join(appDir, "data"), 0o755);
    const expectedUser = `${appUid}:${appGid}`;

    const pull = await docker(["pull", sqliteHelperImage.ref]);
    expect(pull.exitCode).toBe(0);

    const setAppOwner = await docker([
      "run",
      "--rm",
      "--user",
      "0:0",
      "--entrypoint",
      "chown",
      "-v",
      `${appDir}:/app`,
      sqliteHelperImage.ref,
      `${appUid}:${appGid}`,
      "/app/data",
    ]);
    expect(setAppOwner.exitCode).toBe(0);
    expect(appUid).not.toBe(hostUid);

    const paths = makeLandoPaths({
      userConfRoot: join(landoRoot, "conf"),
      userDataRoot: join(landoRoot, "data"),
      userCacheRoot: join(landoRoot, "cache"),
      env: {},
    });
    const stateStore = await Effect.runPromise(
      StateStore.pipe(
        Effect.provide(DiskStateStore.layer),
        Effect.provide(Layer.succeed(PathsService, PathsService.of(paths))),
      ),
    );
    const identity = planAppIdentity({ root: AbsolutePath.make(appDir) });
    const applied = {
      id: AppId.make("sqlite-it"),
      name: "sqlite-it",
      slug: "sqlite-it",
      root: AbsolutePath.make(appDir),
      provider: ProviderId.make("docker"),
      services: {},
      routes: [],
      stores: [],
      fileSync: [],
      identity,
      metadata: { resolvedAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z"), source: "sqlite-it", runtime: 4 },
      extensions: {},
    } as AppPlan;
    const harness = makeSqlTestDeps({ password: "secret", initiallyRunning: false });
    const dbPath = join(appDir, "data", "app.sqlite");
    const deps: SqlCommandDeps = {
      ...harness.deps,
      plan: {
        ...harness.deps.plan,
        root: appDir,
        identity,
        services: {
          appserver: {
            name: "appserver",
            type: "php:8.3",
            environment: {},
            sqlite: { path: "data/app.sqlite" },
            mounts: [{ type: "bind", source: appDir, target: "/app", readOnly: false, role: "app" }],
            storage: [],
          },
        },
      },
      sqlite: {
        applied,
        run: (spec) => runEphemeral(spec),
        pullArtifact: () =>
          Effect.succeed({
            digest: sqliteHelperImage.digest,
          }),
        paths: { ownerSnapshotsDir: paths.ownerSnapshotsDir },
        stateStore,
      },
    };

    const sqlite = deps.sqlite;
    if (sqlite === undefined) throw new Error("Expected SQLite runtime");
    const target = {
      kind: "file" as const,
      name: "appserver",
      type: "php:8.3",
      family: "sqlite" as const,
      path: "data/app.sqlite",
    };
    const query = (sql: string) =>
      docker([
        "run",
        "--rm",
        "--user",
        expectedUser,
        "--entrypoint",
        "sqlite3",
        "-v",
        `${appDir}:/app`,
        sqliteHelperImage.ref,
        "/app/data/app.sqlite",
        sql,
      ]);
    const assertOwned = async (path: string) => {
      // The cloud user namespace can expose a foreign host uid as overflow uid 65534.
      const owner = await docker([
        "run",
        "--rm",
        "--user",
        "0:0",
        "--entrypoint",
        "stat",
        "-v",
        `${appDir}:/app:ro`,
        sqliteHelperImage.ref,
        "-c",
        "%u:%g:%a",
        "/app/data/app.sqlite",
      ]);
      expect(owner.exitCode).toBe(0);
      expect(owner.stdout.trim()).toBe(`${appUid}:${appGid}:644`);
      expect(statSync(path).mode & 0o777).toBe(0o644);
    };

    try {
      const initialized = await query("PRAGMA user_version=0; VACUUM;");
      expect(initialized.exitCode).toBe(0);
      const originalInode = statSync(dbPath).ino;
      const implicitRows =
        "CREATE TABLE implicit_items (name TEXT); INSERT INTO implicit_items(rowid,name) VALUES(42,'forty-two'),(900,'nine-hundred');";
      await writeFile(
        join(appDir, "seed.sql"),
        `CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO items (name) VALUES ('first'); ${implicitRows}\n`,
      );
      await Effect.runPromise(
        executeSqliteCommand(
          deps,
          { action: "import", yes: true, file: join(appDir, "seed.sql") },
          {
            kind: "file",
            name: "appserver",
            type: "php:8.3",
            family: "sqlite",
            path: "data/app.sqlite",
          },
        ),
      );
      await assertOwned(dbPath);

      await Effect.runPromise(
        executeSqliteCommand(
          deps,
          { action: "snapshot", yes: true },
          {
            kind: "file",
            name: "appserver",
            type: "php:8.3",
            family: "sqlite",
            path: "data/app.sqlite",
          },
        ),
      );
      await Effect.runPromise(
        executeSqliteCommand(
          deps,
          { action: "snapshot", yes: true },
          {
            kind: "file",
            name: "appserver",
            type: "php:8.3",
            family: "sqlite",
            path: "data/app.sqlite",
          },
        ),
      );
      await assertOwned(dbPath);

      await writeFile(
        join(appDir, "replace.sql"),
        `CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO items (name) VALUES ('second'); ${implicitRows}\n`,
      );
      await Effect.runPromise(
        executeSqliteCommand(
          deps,
          { action: "import", yes: true, file: join(appDir, "replace.sql") },
          {
            kind: "file",
            name: "appserver",
            type: "php:8.3",
            family: "sqlite",
            path: "data/app.sqlite",
          },
        ),
      );
      await assertOwned(dbPath);

      const queried = await docker(
        [
          "run",
          "--rm",
          "--user",
          expectedUser,
          "--entrypoint",
          "",
          "-v",
          `${appDir}:/app`,
          sqliteHelperImage.ref,
          "sqlite3",
          "/app/data/app.sqlite",
          "SELECT name FROM items;",
        ],
        { cwd: appDir },
      );
      expect(queried.exitCode).toBe(0);
      expect(queried.stdout.trim()).toBe("second");
      expect(statSync(dbPath).ino).toBe(originalInode);

      const rawBackup = await query(".backup main /app/data/raw.sqlite");
      expect(rawBackup.exitCode).toBe(0);
      const rawGzip = join(appDir, "raw.sqlite.gz");
      await writeFile(
        rawGzip,
        Bun.gzipSync(await Bun.file(join(appDir, "data", "raw.sqlite")).arrayBuffer()),
      );
      expect((await query("UPDATE items SET name='changed-before-raw-import';")).exitCode).toBe(0);
      const rawImport = await Effect.runPromise(
        executeSqliteCommand(
          deps,
          {
            action: "import",
            yes: true,
            file: rawGzip,
          },
          target,
        ),
      );
      expect(rawImport.recoverySnapshotId).toBeString();
      expect((await query("SELECT name FROM items;")).stdout.trim()).toBe("second");
      expect(
        (await query("SELECT rowid,name FROM implicit_items ORDER BY rowid;")).stdout.trim().split("\n"),
      ).toEqual(["42|forty-two", "900|nine-hundred"]);
      expect(statSync(dbPath).ino).toBe(originalInode);

      const destructiveDump = join(appDir, "destructive.sql");
      await writeFile(
        destructiveDump,
        ".shell printf corrupted > /app/data/app.sqlite\nATTACH '/app/data/app.sqlite' AS live; DROP TABLE live.items;\n",
      );
      const capturedBeforeBadDump = Array.from(
        new Bun.Glob("sqlite-*/*.tar").scanSync({ cwd: paths.ownerSnapshotsDir(identity.ownerKey) }),
      ).length;
      const rejectedDump = await Effect.runPromiseExit(
        executeSqliteCommand(
          deps,
          {
            action: "import",
            yes: true,
            file: destructiveDump,
          },
          target,
        ),
      );
      expect(Exit.isFailure(rejectedDump)).toBe(true);
      if (!Exit.isFailure(rejectedDump))
        throw new Error("A dump accessing the target mount must fail in staging");
      const dumpError = Option.getOrUndefined(Cause.findErrorOption(rejectedDump.cause));
      expect(dumpError).toBeInstanceOf(SqlCommandFailedError);
      if (!(dumpError instanceof SqlCommandFailedError)) throw new Error("Expected isolated staging failure");
      expect(dumpError.recoverySnapshotId).toBeUndefined();
      expect(Array.from(new Bun.Glob(".lando-sqlite-proof.*").scanSync({ cwd: appDir }))).toEqual([]);
      expect((await query("SELECT name FROM items;")).stdout.trim()).toBe("second");
      expect(
        Array.from(
          new Bun.Glob("sqlite-*/*.tar").scanSync({ cwd: paths.ownerSnapshotsDir(identity.ownerKey) }),
        ).length,
      ).toBe(capturedBeforeBadDump);

      for (const journalMode of ["delete", "wal"]) {
        const competingWrites: number[] = [];
        const fencedStore: StateStoreShape = {
          ...stateStore,
          open: (request) =>
            stateStore.open(request).pipe(
              Effect.map((bucket) => ({
                ...bucket,
                set: (value) =>
                  Effect.promise(async () => {
                    const attempted = await query("INSERT INTO items(name) VALUES('racing');");
                    competingWrites.push(attempted.exitCode);
                  }).pipe(Effect.andThen(bucket.set(value))),
              })),
            ),
        };
        const resetDeps: SqlCommandDeps = { ...deps, sqlite: { ...sqlite, stateStore: fencedStore } };
        const objects = await query(`
        PRAGMA journal_mode=${journalMode};
        PRAGMA user_version=42;
        CREATE INDEX IF NOT EXISTS items_name ON items(name);
        CREATE VIEW IF NOT EXISTS item_names AS SELECT name FROM items;
        CREATE TRIGGER IF NOT EXISTS items_touch AFTER INSERT ON items BEGIN UPDATE items SET name=upper(name) WHERE id=new.id; END;
      `);
        expect(objects.exitCode).toBe(0);
        const otherDatabase = join(appDir, "other.sqlite");
        await writeFile(otherDatabase, "another database remains untouched");
        const reset = await Effect.runPromise(
          executeSqliteCommand(resetDeps, { action: "reset", yes: true }, target),
        );
        expect(reset.recoverySnapshotId).toBeString();
        expect(competingWrites).toHaveLength(1);
        expect(competingWrites[0]).not.toBe(0);
        expect(statSync(dbPath).ino).toBe(originalInode);
        await assertOwned(dbPath);
        expect(await Bun.file(otherDatabase).text()).toBe("another database remains untouched");
        const empty = await query(
          "SELECT count(*) FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'; PRAGMA user_version; PRAGMA journal_mode; PRAGMA integrity_check;",
        );
        expect(empty.exitCode).toBe(0);
        expect(empty.stdout.trim().split("\n")).toEqual(["0", "0", journalMode, "ok"]);
        const usable = await query(
          "CREATE TABLE after_reset (id INTEGER); INSERT INTO after_reset VALUES (1); SELECT id FROM after_reset;",
        );
        expect(usable.exitCode).toBe(0);
        expect(usable.stdout.trim()).toBe("1");

        const recoveryId = reset.recoverySnapshotId ?? "";
        const catalog = await Effect.runPromise(
          stateStore.open({
            root: {
              path: AbsolutePath.make(
                join(paths.ownerSnapshotsDir(identity.ownerKey), sqliteSnapshotStore(target.path)),
              ),
            },
            key: `${recoveryId}.json`,
            schema: SnapshotInfo,
            version: 1,
            codec: "json",
            onCorrupt: "fail",
          }),
        );
        const recovery = await Effect.runPromise(catalog.get);
        expect(recovery?.metadata?.recoveryReason).toBe("reset");
        if (recovery === null) throw new Error("Expected reset recovery snapshot");
        const restored = await Effect.runPromise(
          executeSqliteCommand(
            {
              ...deps,
              resolveSnapshot: () => Effect.succeed(recovery),
            },
            { action: "restore", yes: true, snapshotId: recoveryId },
            target,
          ),
        );
        expect(restored.recoverySnapshotId).toBeString();
        expect(statSync(dbPath).ino).toBe(originalInode);
        const recovered = await query(
          "SELECT name FROM items; SELECT count(*) FROM sqlite_schema WHERE name='after_reset'; PRAGMA user_version;",
        );
        expect(recovered.exitCode).toBe(0);
        expect(recovered.stdout.trim().split("\n")).toEqual(["second", "0", "42"]);
        const implicitRestored = await query("SELECT rowid,name FROM implicit_items ORDER BY rowid;");
        expect(implicitRestored.exitCode).toBe(0);
        expect(implicitRestored.stdout.trim().split("\n")).toEqual(["42|forty-two", "900|nine-hundred"]);
      }

      const failedCatalogStore: StateStoreShape = {
        ...stateStore,
        open: () =>
          Effect.fail(
            new StateStoreError({
              reason: "io",
              operation: "open",
              cause: "injected catalog failure",
              remediation: "Retry after resolving the catalog write failure.",
            }),
          ),
      };
      const failedCatalog = await Effect.runPromiseExit(
        executeSqliteCommand(
          {
            ...deps,
            sqlite: { ...sqlite, stateStore: failedCatalogStore },
          },
          { action: "reset", yes: true },
          target,
        ),
      );
      expect(Exit.isFailure(failedCatalog)).toBe(true);
      if (!Exit.isFailure(failedCatalog)) throw new Error("Catalog failure must stop reset");
      const catalogError = Option.getOrUndefined(Cause.findErrorOption(failedCatalog.cause));
      expect(catalogError).toBeInstanceOf(SqlRecoveryOperationError);
      if (!(catalogError instanceof SqlRecoveryOperationError))
        throw new Error("Expected recovery operation failure");
      expect(catalogError.recoverySnapshotId).toBeString();
      expect(
        await Bun.file(
          join(
            paths.ownerSnapshotsDir(identity.ownerKey),
            sqliteSnapshotStore(target.path),
            `${catalogError.recoverySnapshotId}.tar`,
          ),
        ).exists(),
      ).toBe(true);
      const preservedPayloads = Array.from(
        new Bun.Glob("sqlite-helper/*/*.sqlite").scanSync({
          cwd: paths.ownerSnapshotsDir(identity.ownerKey),
          absolute: true,
        }),
      );
      expect(preservedPayloads.length).toBeGreaterThan(0);
      expect((await query("SELECT name FROM items;")).stdout.trim()).toBe("second");
      expect(statSync(dbPath).ino).toBe(originalInode);

      const earlyExit = await Effect.runPromiseExit(
        executeSqliteCommand(
          {
            ...deps,
            sqlite: {
              ...sqlite,
              run: (spec) => {
                const source = spec.stdinStream;
                if (source === undefined) return runEphemeral(spec);
                const intercepted = async function* () {
                  let chunks = 0;
                  for await (const chunk of source) {
                    chunks++;
                    yield chunks === 1 ? chunk : new TextEncoder().encode(".quit\n");
                  }
                };
                return runEphemeral({ ...spec, stdinStream: intercepted() });
              },
            },
          },
          { action: "reset", yes: true },
          target,
        ),
      );
      expect(Exit.isFailure(earlyExit)).toBe(true);
      if (!Exit.isFailure(earlyExit)) throw new Error("Premature successful helper exit must fail reset");
      const earlyError = Option.getOrUndefined(Cause.findErrorOption(earlyExit.cause));
      expect(earlyError).toBeInstanceOf(SqlRecoveryOperationError);
      if (!(earlyError instanceof SqlRecoveryOperationError))
        throw new Error("Expected recovery operation failure");
      expect(earlyError.recoverySnapshotId).toBeString();
      expect((await query("SELECT name FROM items;")).stdout.trim()).toBe("second");
      expect(statSync(dbPath).ino).toBe(originalInode);

      for (const lockKind of ["writer", "reader"]) {
        const readyPath = `lock-ready-${lockKind}`;
        const holderName = `lando-sqlite-holder-${crypto.randomUUID()}`;
        const holder = Bun.spawn(
          [
            "docker",
            "run",
            "--rm",
            "-i",
            "--name",
            holderName,
            "--user",
            expectedUser,
            "--entrypoint",
            "sqlite3",
            "-v",
            `${appDir}:/app`,
            sqliteHelperImage.ref,
            "/app/data/app.sqlite",
          ],
          { env: dockerEnv, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
        );
        try {
          holder.stdin.write(
            `${
              lockKind === "writer"
                ? "BEGIN IMMEDIATE; INSERT INTO items(name) VALUES('uncommitted');"
                : "BEGIN; SELECT name FROM items;"
            }\n.shell touch /app/data/${readyPath}\n`,
          );
          holder.stdin.flush();
          for (let attempt = 0; !(await Bun.file(join(appDir, "data", readyPath)).exists()); attempt++) {
            if (attempt >= 500) throw new Error("External SQLite writer did not acquire its lock");
            await Bun.sleep(10);
          }
          const refused = await Effect.runPromiseExit(
            executeSqliteCommand(
              deps,
              Object.assign({ action: "reset" as const, yes: true }, { force: true }),
              target,
            ),
          );
          expect(Exit.isFailure(refused)).toBe(true);
          if (!Exit.isFailure(refused)) throw new Error("Reset must refuse an external writer");
          const error = Option.getOrUndefined(Cause.findErrorOption(refused.cause));
          expect(error).toBeInstanceOf(SqlCommandFailedError);
          if (!(error instanceof SqlCommandFailedError)) throw new Error("Expected busy helper failure");
          expect(error.recoverySnapshotId).toBeUndefined();
          expect(error.stderrTail).toContain("locked");
          expect(statSync(dbPath).ino).toBe(originalInode);
        } finally {
          holder.stdin.write("ROLLBACK;\n.quit\n");
          holder.stdin.end();
          await holder.exited;
          await docker(["rm", "-f", holderName]);
        }
        const retained = await query("SELECT name FROM items;");
        expect(retained.exitCode).toBe(0);
        expect(retained.stdout.trim()).toBe("second");
      }
      expect(Array.from(new Bun.Glob(".lando-sqlite-proof.*").scanSync({ cwd: appDir }))).toEqual([]);
    } finally {
      cleanupSqlTestDeps();
      await docker([
        "run",
        "--rm",
        "--user",
        "0:0",
        "--entrypoint",
        "chown",
        "-v",
        `${appDir}:/app`,
        sqliteHelperImage.ref,
        "-R",
        `${hostUid}:${hostGid}`,
        "/app/data",
      ]);
      await rm(appDir, { recursive: true, force: true });
      await rm(landoRoot, { recursive: true, force: true });
    }
  },
  240_000,
);

test.skipIf(dockerHost === undefined)(
  `SQLite named-volume subpath selects only the intended database${dockerHost === undefined ? " (SKIP: LANDO_TEST_DOCKER_SOCKET required)" : ""}`,
  async () => {
    if (dockerHost === undefined) throw new Error("LANDO_TEST_DOCKER_SOCKET required");
    const appDir = await mkdtemp(join(tmpdir(), "lando-sqlite-subpath-app-"));
    const landoRoot = await mkdtemp(join(tmpdir(), "lando-sqlite-subpath-data-"));
    const volume = `lando-sqlite-subpath-${crypto.randomUUID()}`;
    const harness = makeSqlTestDeps({ password: "secret", initiallyRunning: false });
    try {
      expect((await docker(["pull", sqliteHelperImage.ref])).exitCode).toBe(0);
      expect((await docker(["volume", "create", volume])).exitCode).toBe(0);
      const initialized = await docker([
        "run",
        "--rm",
        "--user",
        "0:0",
        "--entrypoint",
        "sh",
        "-v",
        `${volume}:/volume`,
        sqliteHelperImage.ref,
        "-eu",
        "-c",
        `
          mkdir -p /volume/selected;
          sqlite3 /volume/site.sqlite "CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES('root-sentinel');";
          sqlite3 /volume/selected/site.sqlite "CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES('selected-sentinel');";
          chown -R 1001:1001 /volume;
        `,
      ]);
      expect(initialized.exitCode).toBe(0);
      const query = (path: string, sql: string) =>
        docker([
          "run",
          "--rm",
          "--user",
          "1001:1001",
          "--entrypoint",
          "sqlite3",
          "--mount",
          `type=volume,src=${volume},dst=/volume`,
          sqliteHelperImage.ref,
          "-ifexists",
          path,
          sql,
        ]);
      const rootDigest = async () => {
        const hashed = await docker([
          "run",
          "--rm",
          "--user",
          "1001:1001",
          "--entrypoint",
          "sha256sum",
          "--mount",
          `type=volume,src=${volume},dst=/volume,readonly`,
          sqliteHelperImage.ref,
          "/volume/site.sqlite",
        ]);
        expect(hashed.exitCode).toBe(0);
        return hashed.stdout.trim();
      };
      const originalRootDigest = await rootDigest();
      const rootSentinel = async () => {
        const queried = await query("/volume/site.sqlite", "SELECT value FROM marker;");
        expect(queried.exitCode).toBe(0);
        expect(queried.stdout.trim()).toBe("root-sentinel");
        expect(await rootDigest()).toBe(originalRootDigest);
      };
      const paths = makeLandoPaths({
        userConfRoot: join(landoRoot, "conf"),
        userDataRoot: join(landoRoot, "data"),
        userCacheRoot: join(landoRoot, "cache"),
        env: {},
      });
      const stateStore = await Effect.runPromise(
        StateStore.pipe(
          Effect.provide(DiskStateStore.layer),
          Effect.provide(Layer.succeed(PathsService, PathsService.of(paths))),
        ),
      );
      const identity = planAppIdentity({ root: AbsolutePath.make(appDir) });
      const applied = {
        id: AppId.make("sqlite-subpath-it"),
        name: "sqlite-subpath-it",
        slug: "sqlite-subpath-it",
        root: AbsolutePath.make(appDir),
        provider: ProviderId.make("docker"),
        services: {},
        routes: [],
        stores: [],
        fileSync: [],
        identity,
        metadata: {
          resolvedAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
          source: "sqlite-subpath-it",
          runtime: 4,
        },
        extensions: {},
      } as AppPlan;
      const service = {
        name: "appserver",
        type: "php:8.3",
        environment: {},
        sqlite: { path: "data/site.sqlite" },
        mounts: [
          { type: "bind" as const, source: appDir, target: "/app", readOnly: false, role: "app" as const },
          {
            type: "volume" as const,
            store: volume,
            target: "/app/data",
            readOnly: false,
            subpath: "selected",
          },
        ],
        storage: [],
      };
      const coordinationKey = `sqlite-integration:${volume}`;
      const volumeIdentity = {
        coordinationKey,
        nativeName: volume,
        generation: crypto.randomUUID(),
        ownerRoot: identity.appRoot,
        origin: "created" as const,
      };
      const deps: SqlCommandDeps = {
        ...harness.deps,
        plan: { ...harness.deps.plan, root: appDir, identity, services: { appserver: service } },
        sqlite: {
          applied,
          // Inject the provider identity contract for this raw-Docker fixture. This adapter
          // does not validate production ownership labels or the provider's daemon namespace.
          locateVolume: () =>
            Effect.succeed({ coordinationKey, nativeName: volume, identity: volumeIdentity }),
          run: runEphemeral,
          pullArtifact: () => Effect.succeed({ digest: sqliteHelperImage.digest }),
          paths: { ownerSnapshotsDir: paths.ownerSnapshotsDir },
          stateStore,
        },
      };
      const target = {
        kind: "file" as const,
        name: "appserver",
        type: "php:8.3",
        family: "sqlite" as const,
        path: "data/site.sqlite",
      };
      const snapshot = await Effect.runPromise(
        executeSqliteCommand(deps, { action: "snapshot", yes: true }, target),
      );
      expect(snapshot.snapshotId).toBeString();
      await rootSentinel();
      const reset = await Effect.runPromise(
        executeSqliteCommand(deps, { action: "reset", yes: true }, target),
      );
      expect(reset.recoverySnapshotId).toBeString();
      expect(
        (
          await query(
            "/volume/selected/site.sqlite",
            "SELECT count(*) FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*';",
          )
        ).stdout.trim(),
      ).toBe("0");
      await rootSentinel();
      const importedSql = join(appDir, "replacement.sql");
      await writeFile(
        importedSql,
        "CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES('selected-imported');",
      );
      const imported = await Effect.runPromise(
        executeSqliteCommand(deps, { action: "import", yes: true, file: importedSql }, target),
      );
      expect(imported.recoverySnapshotId).toBeString();
      expect((await query("/volume/selected/site.sqlite", "SELECT value FROM marker;")).stdout.trim()).toBe(
        "selected-imported",
      );
      await rootSentinel();
      const snapshotId = snapshot.snapshotId ?? "";
      const bucket = await Effect.runPromise(
        stateStore.open({
          root: {
            path: AbsolutePath.make(
              join(paths.ownerSnapshotsDir(identity.ownerKey), sqliteSnapshotStore(target.path)),
            ),
          },
          key: `${snapshotId}.json`,
          schema: SnapshotInfo,
          version: 1,
          codec: "json",
          onCorrupt: "fail",
        }),
      );
      const source = await Effect.runPromise(bucket.get);
      if (source === null) throw new Error("Expected the named-volume snapshot catalog");
      const restored = await Effect.runPromise(
        executeSqliteCommand(
          { ...deps, resolveSnapshot: () => Effect.succeed(source) },
          {
            action: "restore",
            yes: true,
            snapshotId,
          },
          target,
        ),
      );
      expect(restored.recoverySnapshotId).toBeString();
      expect((await query("/volume/selected/site.sqlite", "SELECT value FROM marker;")).stdout.trim()).toBe(
        "selected-sentinel",
      );
      await rootSentinel();
      const missingSubpathService = {
        ...service,
        mounts: service.mounts.map((mount) =>
          mount.type === "volume" ? { ...mount, subpath: "missing" } : mount,
        ),
      };
      const missing = await Effect.runPromiseExit(
        executeSqliteCommand(
          {
            ...deps,
            plan: { ...deps.plan, services: { appserver: missingSubpathService } },
          },
          { action: "reset", yes: true },
          target,
        ),
      );
      expect(Exit.isFailure(missing)).toBe(true);
      if (!Exit.isFailure(missing))
        throw new Error("Missing volume subpath must not fall back to the volume root");
      const missingError = Option.getOrUndefined(Cause.findErrorOption(missing.cause));
      expect(missingError).toBeInstanceOf(SqlRecoveryUnavailableError);
      expect((await query("/volume/selected/site.sqlite", "SELECT value FROM marker;")).stdout.trim()).toBe(
        "selected-sentinel",
      );
      await rootSentinel();
    } finally {
      cleanupSqlTestDeps();
      await docker(["volume", "rm", "-f", volume]);
      await rm(appDir, { recursive: true, force: true });
      await rm(landoRoot, { recursive: true, force: true });
    }
  },
  240_000,
);
