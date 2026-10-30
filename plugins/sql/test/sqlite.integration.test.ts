import { chmodSync, chownSync, mkdirSync, mkdtempSync, statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";
import { Effect, Layer } from "effect";

import { sqliteHelperImage } from "@lando/container-runtime/data-plane";
import { makeLandoPaths } from "@lando/paths";
import { AbsolutePath, AppId, type AppPlan, ProviderId, planAppIdentity } from "@lando/sdk/schema";
import type { EphemeralRunSpec, ExecResult } from "@lando/sdk/services";
import { PathsService, StateStore } from "@lando/sdk/services";
import * as DiskStateStore from "@lando/state-store/service";

import type { SqlCommandDeps } from "../src/command-types.ts";
import { packSqliteTar, unpackSqliteTar } from "../src/sqlite-archive.ts";
import { executeSqliteCommand } from "../src/sqlite-execute.ts";
import { isSqliteDatabaseHeader } from "../src/sqlite-header.ts";
import { sqliteHelperUser } from "../src/sqlite-mount.ts";
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
  const proc = Bun.spawn(["docker", ...args], {
    cwd: options?.cwd,
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
    if (spec.stdinStream !== undefined) args.push("-i");
    args.push(spec.image, ...spec.command);
    const result = await docker(args, {
      ...(spec.stdinStream === undefined ? {} : { stdin: spec.stdinStream }),
    });
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || `docker run exited ${result.exitCode}`);
    }
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
      const create = await docker(
        [
          "run",
          "--rm",
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
    const appUid = hostUid === 0 ? 1000 : hostUid;
    const appGid = hostGid === 0 ? 1000 : hostGid;
    const appDir = mkdtempSync(join(tmpdir(), "lando-sqlite-provider-app-"));
    const landoRoot = mkdtempSync(join(tmpdir(), "lando-sqlite-provider-data-"));
    mkdirSync(join(appDir, "data"), { recursive: true });
    chownSync(appDir, appUid, appGid);
    chownSync(join(appDir, "data"), appUid, appGid);
    chmodSync(appDir, 0o755);
    chmodSync(join(appDir, "data"), 0o755);
    const expectedUser = sqliteHelperUser({
      kind: "bind",
      source: appDir,
      target: "/app",
      readOnly: false,
    });
    expect(expectedUser).toBe(`${appUid}:${appGid}`);

    const pull = await docker(["pull", sqliteHelperImage.ref]);
    expect(pull.exitCode).toBe(0);

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
      identity: planAppIdentity({ root: AbsolutePath.make(appDir) }),
    } as AppPlan;
    const harness = makeSqlTestDeps({ password: "secret", initiallyRunning: false });
    const dbPath = join(appDir, "data", "app.sqlite");
    const deps: SqlCommandDeps = {
      ...harness.deps,
      plan: {
        ...harness.deps.plan,
        root: appDir,
        identity: applied.identity,
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

    const assertOwned = (path: string) => {
      const info = statSync(path);
      expect(info.uid).toBe(appUid);
      expect(info.gid).toBe(appGid);
      expect(info.mode & 0o777).toBe(0o644);
    };

    try {
      await writeFile(
        join(appDir, "seed.sql"),
        "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO items (name) VALUES ('first');\n",
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
      assertOwned(dbPath);

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
      assertOwned(dbPath);

      await writeFile(
        join(appDir, "replace.sql"),
        "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO items (name) VALUES ('second');\n",
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
      assertOwned(dbPath);

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
    } finally {
      cleanupSqlTestDeps();
      await rm(appDir, { recursive: true, force: true });
      await rm(landoRoot, { recursive: true, force: true });
    }
  },
  240_000,
);
