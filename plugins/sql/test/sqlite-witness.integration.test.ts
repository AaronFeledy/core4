import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeProviderDataPlane, sqliteHelperImage } from "@lando/container-runtime/data-plane";
import { dockerPullDialect } from "@lando/container-runtime/dialect";
import { makeDockerApiClient } from "@lando/container-runtime/docker/api-client";
import { pullImage } from "@lando/container-runtime/image-pull";
import { standaloneSecretsRedactor } from "@lando/container-runtime/redact";
import { makeLandoPaths } from "@lando/paths";
import { SqlRecoveryUnavailableError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  PortablePath,
  ProviderId,
  SnapshotInfo,
  planAppIdentity,
} from "@lando/sdk/schema";
import { PathsService, StateStore } from "@lando/sdk/services";
import * as DiskStateStore from "@lando/state-store/service";
import { Cause, DateTime, Effect, Exit, Layer, Option } from "effect";

import type { SqlCommandDeps } from "../src/command-types.ts";
import { unpackSqliteTarFile } from "../src/sqlite-archive.ts";
import { executeSqliteCommand } from "../src/sqlite-execute.ts";
import { sqliteSnapshotStore } from "../src/sqlite-path.ts";
import { cleanupSqlTestDeps, makeSqlTestDeps } from "./support/fakes.ts";

const socket = process.env.LANDO_TEST_DOCKER_SOCKET || undefined;
const dockerHost =
  socket === undefined ? undefined : socket.startsWith("unix://") ? socket : `unix://${socket}`;
afterEach(cleanupSqlTestDeps);

const docker = async (args: ReadonlyArray<string>) => {
  const child = Bun.spawn(["docker", ...args], {
    env: dockerHost === undefined ? process.env : { ...process.env, DOCKER_HOST: dockerHost },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};

test.skipIf(dockerHost === undefined)(
  `production volume witness gates SQLite recovery on real Docker${dockerHost === undefined ? " (SKIP: LANDO_TEST_DOCKER_SOCKET required)" : ""}`,
  async () => {
    if (dockerHost === undefined) throw new Error("LANDO_TEST_DOCKER_SOCKET required");
    const root = await mkdtemp(join(tmpdir(), "lando-sqlite-witness-"));
    const foreignRoot = await mkdtemp(join(tmpdir(), "lando-sqlite-foreign-"));
    const dataRoot = await mkdtemp(join(tmpdir(), "lando-sqlite-witness-data-"));
    const volume = `lando-sqlite-witness-${crypto.randomUUID()}`;
    const holder = `lando-sqlite-holder-${crypto.randomUUID()}`;
    let holderId = "";
    const ctx = {
      providerId: "docker",
      remediation: "Start the selected Docker daemon and retry.",
      env: {},
      redactor: standaloneSecretsRedactor({}),
    };
    const client = makeDockerApiClient(dockerHost, ctx, { env: {} });
    const request = client.request;
    if (request === undefined) throw new Error("Docker request client is required");
    let sqliteCreates = 0;
    let sqlitePulls = 0;
    const apiFailures: Array<{ method: string; path: string; status: number; body: string }> = [];
    const api = {
      ...client,
      request: (input: Parameters<typeof request>[0]) => {
        if (input.method === "POST" && input.path.startsWith("/containers/create?")) {
          const body = input.body;
          if (
            body !== null &&
            typeof body === "object" &&
            "Image" in body &&
            body.Image === sqliteHelperImage.ref
          )
            sqliteCreates++;
        }
        return request(input).pipe(
          Effect.tap((response) =>
            Effect.sync(() => {
              if (response.status >= 400)
                apiFailures.push({
                  method: input.method,
                  path: input.path,
                  status: response.status,
                  body: response.body,
                });
            }),
          ),
        );
      },
    };
    const pullArtifact = (spec: {
      readonly ref: string;
      readonly policy?: "always" | "missing" | "never";
    }) => {
      if (spec.ref === sqliteHelperImage.ref) sqlitePulls++;
      return pullImage(api, spec.ref, { ctx, dialect: dockerPullDialect, policy: spec.policy ?? "missing" });
    };
    const plane = makeProviderDataPlane({
      providerId: "docker",
      endpointNamespace: dockerHost,
      api,
      capabilities: { volumeSnapshot: "none" },
      redactor: ctx.redactor,
      pullHelperImage: (ref) => pullArtifact({ ref, policy: "missing" }),
    });
    const call = (input: Parameters<typeof request>[0]) => Effect.runPromise(request(input));
    try {
      await Effect.runPromise(client.info);
      await Effect.runPromise(pullArtifact({ ref: sqliteHelperImage.ref, policy: "missing" }));
      expect((await call({ method: "POST", path: "/volumes/create", body: { Name: volume } })).status).toBe(
        201,
      );
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
          sqlite3 /volume/other.sqlite "CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES('root-sentinel');";
          sqlite3 /volume/site.sqlite "CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES('selected-sentinel');";
          chown 1001:1001 /volume /volume/site.sqlite;
        `,
      ]);
      expect(initialized.exitCode).toBe(0);
      const created = await call({
        method: "POST",
        path: `/containers/create?name=${holder}`,
        body: {
          Image: sqliteHelperImage.ref,
          Entrypoint: [],
          Cmd: ["sh", "-c", "trap 'exit 0' TERM INT; while :; do sleep 300 & wait $!; done"],
          HostConfig: { Binds: [`${volume}:/lando-data`], NetworkMode: "none" },
        },
      });
      expect(created.status).toBe(201);
      holderId = (JSON.parse(created.body) as { Id: string }).Id;
      expect((await call({ method: "POST", path: `/containers/${holderId}/start` })).status).toBe(204);
      const identity = planAppIdentity({ root: AbsolutePath.make(root) });
      const app = AppId.make(`sqlite-witness-${crypto.randomUUID()}`);
      const applied: AppPlan = {
        valueModel: 1,
        id: app,
        name: app,
        slug: app,
        root: identity.appRoot,
        identity,
        provider: ProviderId.make("docker"),
        services: {},
        networking: { perAppBridge: { name: `${app}-network`, driver: "bridge" } },
        routes: [],
        stores: [{ name: volume, scope: "app", kind: "data" }],
        fileSync: [],
        metadata: {
          resolvedAt: DateTime.makeUnsafe("2026-10-31T00:00:00Z"),
          source: "sqlite-witness-it",
          runtime: 4,
        },
        extensions: {},
      };
      const paths = makeLandoPaths({
        userConfRoot: join(dataRoot, "conf"),
        userDataRoot: join(dataRoot, "data"),
        userCacheRoot: join(dataRoot, "cache"),
        env: {},
      });
      const stateStore = await Effect.runPromise(
        StateStore.pipe(
          Effect.provide(DiskStateStore.layer),
          Effect.provide(Layer.succeed(PathsService, PathsService.of(paths))),
        ),
      );
      const harness = makeSqlTestDeps({ password: "secret", initiallyRunning: false });
      const service = {
        name: "appserver",
        type: "php:8.3",
        environment: {},
        sqlite: { path: "data/site.sqlite" },
        mounts: [
          { type: "bind" as const, source: root, target: "/app", role: "app" as const, readOnly: false },
          {
            type: "volume" as const,
            store: volume,
            target: "/app/data",
            readOnly: false,
          },
        ],
        storage: [],
      };
      const deps: SqlCommandDeps = {
        ...harness.deps,
        plan: { ...harness.deps.plan, id: app, root, identity, services: { appserver: service } },
        sqlite: {
          applied,
          run: (spec) => Effect.scoped(plane.run(spec)),
          pullArtifact,
          locateVolume: plane.locateVolume,
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
      const digest = async (path: string) => {
        const result = await docker([
          "run",
          "--rm",
          "--user",
          "0:0",
          "--entrypoint",
          "sha256sum",
          "--mount",
          `type=volume,src=${volume},dst=/volume,readonly`,
          sqliteHelperImage.ref,
          path,
        ]);
        expect(result.exitCode).toBe(0);
        return result.stdout.trim();
      };
      const originalDbDigest = await digest("/volume/site.sqlite");
      const originalRootDigest = await digest("/volume/other.sqlite");
      const missingBefore = { creates: sqliteCreates, pulls: sqlitePulls };
      const missing = await Effect.runPromiseExit(
        executeSqliteCommand(deps, { action: "reset", yes: true }, target),
      );
      expect(Exit.isFailure(missing)).toBe(true);
      if (!Exit.isFailure(missing)) throw new Error("An unlabeled volume without a witness must fail closed");
      expect(Option.getOrUndefined(Cause.findErrorOption(missing.cause))).toBeInstanceOf(
        SqlRecoveryUnavailableError,
      );
      expect(sqliteCreates).toBe(missingBefore.creates);
      expect(sqlitePulls).toBe(missingBefore.pulls);
      expect(await digest("/volume/site.sqlite")).toBe(originalDbDigest);

      const adoption = await Effect.runPromise(
        plane.adoptVolume({
          app,
          containerId: holderId,
          destination: PortablePath.make("/lando-data"),
          ownerRoot: identity.appRoot,
        }),
      );
      expect(adoption.identity?.origin).toBe("adopted");
      expect(adoption.identity?.ownerRoot).toBe(identity.appRoot);
      const located = await Effect.runPromise(plane.locateVolume({ app, store: volume }));
      expect(located.identity).toEqual(adoption.identity);
      const witnessDigest = await digest("/volume/.lando-volume-witness.json");
      const snapshot = await Effect.runPromise(
        executeSqliteCommand(deps, { action: "snapshot", yes: true }, target),
      );
      expect(snapshot.snapshotId).toBeString();
      const reset = await Effect.runPromise(
        executeSqliteCommand(deps, { action: "reset", yes: true }, target),
      );
      expect(reset.recoverySnapshotId).toBeString();
      const empty = await docker([
        "run",
        "--rm",
        "--user",
        "1001:1001",
        "--entrypoint",
        "sqlite3",
        "--mount",
        `type=volume,src=${volume},dst=/volume`,
        sqliteHelperImage.ref,
        "-readonly",
        "-ifexists",
        "/volume/site.sqlite",
        "SELECT count(*) FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*';",
      ]);
      expect(empty.exitCode).toBe(0);
      expect(empty.stdout.trim()).toBe("0");
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
      if (source === null) throw new Error("Expected the real snapshot catalog");
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
      const restoredData = await docker([
        "run",
        "--rm",
        "--user",
        "1001:1001",
        "--entrypoint",
        "sqlite3",
        "--mount",
        `type=volume,src=${volume},dst=/volume,readonly`,
        sqliteHelperImage.ref,
        "-readonly",
        "-ifexists",
        "/volume/site.sqlite",
        "SELECT value FROM marker;",
      ]);
      expect(restoredData.exitCode).toBe(0);
      expect(restoredData.stdout.trim()).toBe("selected-sentinel");
      const restoredDbDigest = await digest("/volume/site.sqlite");
      expect(await digest("/volume/other.sqlite")).toBe(originalRootDigest);
      expect(await digest("/volume/.lando-volume-witness.json")).toBe(witnessDigest);
      expect((await Effect.runPromise(plane.locateVolume({ app, store: volume }))).identity).toEqual(
        adoption.identity,
      );

      const sqlite = deps.sqlite;
      if (sqlite === undefined) throw new Error("Expected the SQLite runtime");
      const foreignIdentity = planAppIdentity({ root: AbsolutePath.make(foreignRoot) });
      const foreignApplied: AppPlan = {
        ...applied,
        root: foreignIdentity.appRoot,
        identity: foreignIdentity,
      };
      const foreignDeps: SqlCommandDeps = {
        ...deps,
        plan: { ...deps.plan, root: foreignRoot, identity: foreignIdentity },
        sqlite: { ...sqlite, applied: foreignApplied },
      };
      const foreignBefore = { creates: sqliteCreates, pulls: sqlitePulls };
      const foreign = await Effect.runPromiseExit(
        executeSqliteCommand(foreignDeps, { action: "reset", yes: true }, target),
      );
      expect(Exit.isFailure(foreign)).toBe(true);
      if (!Exit.isFailure(foreign))
        throw new Error("A foreign real witness must reject the SQLite operation");
      expect(Option.getOrUndefined(Cause.findErrorOption(foreign.cause))).toBeInstanceOf(
        SqlRecoveryUnavailableError,
      );
      expect(sqliteCreates).toBe(foreignBefore.creates);
      expect(sqlitePulls).toBe(foreignBefore.pulls);
      expect(await digest("/volume/site.sqlite")).toBe(restoredDbDigest);
      expect(await digest("/volume/.lando-volume-witness.json")).toBe(witnessDigest);
      const foreignAdoption = await Effect.runPromiseExit(
        plane.adoptVolume({
          app,
          containerId: holderId,
          destination: PortablePath.make("/lando-data"),
          ownerRoot: foreignIdentity.appRoot,
        }),
      );
      expect(Exit.isFailure(foreignAdoption)).toBe(true);
      expect(await digest("/volume/.lando-volume-witness.json")).toBe(witnessDigest);

      const subpathFixture = await docker([
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
          mkdir /volume/subpath;
          sqlite3 /volume/subpath/site.sqlite "CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES('native-subpath-sentinel');";
          chown -R 1001:1001 /volume/subpath;
        `,
      ]);
      expect(subpathFixture.exitCode).toBe(0);
      const subpathService = {
        ...service,
        mounts: service.mounts.map((mount) =>
          mount.type === "volume" ? { ...mount, subpath: "subpath" } : mount,
        ),
      };
      const nativeSubpath = await Effect.runPromiseExit(
        executeSqliteCommand(
          {
            ...deps,
            plan: { ...deps.plan, services: { appserver: subpathService } },
          },
          { action: "snapshot", yes: true },
          target,
        ),
      );
      // Keep the real client's default API negotiation. Older negotiated APIs must reject
      // subpaths safely; a future supported API must capture the subpath's distinct data.
      if (Exit.isFailure(nativeSubpath)) {
        expect(Option.getOrUndefined(Cause.findErrorOption(nativeSubpath.cause))).toBeInstanceOf(
          SqlRecoveryUnavailableError,
        );
        expect(
          apiFailures.some(
            (failure) =>
              failure.status === 400 &&
              failure.body.includes("VolumeOptions.Subpath needs API v1.45 or newer"),
          ),
        ).toBe(true);
      } else {
        const id = nativeSubpath.value.snapshotId;
        expect(id).toBeString();
        const payload = join(root, "native-subpath.sqlite");
        expect(
          await unpackSqliteTarFile(
            join(paths.ownerSnapshotsDir(identity.ownerKey), sqliteSnapshotStore(target.path), `${id}.tar`),
            payload,
          ),
        ).toBe(true);
        const capturedData = await docker([
          "run",
          "--rm",
          "--user",
          "0:0",
          "--entrypoint",
          "sqlite3",
          "-v",
          `${root}:/archive:ro`,
          sqliteHelperImage.ref,
          "-readonly",
          "-ifexists",
          "/archive/native-subpath.sqlite",
          "SELECT value FROM marker;",
        ]);
        expect(capturedData.exitCode).toBe(0);
        expect(capturedData.stdout.trim()).toBe("native-subpath-sentinel");
      }
      expect(await digest("/volume/site.sqlite")).toBe(restoredDbDigest);
      expect(await digest("/volume/other.sqlite")).toBe(originalRootDigest);
      expect(await digest("/volume/.lando-volume-witness.json")).toBe(witnessDigest);
    } catch (cause) {
      if (apiFailures.length > 0)
        throw new Error(`Production Docker API failures: ${JSON.stringify(apiFailures)}`, { cause });
      throw cause;
    } finally {
      if (holderId !== "")
        await call({ method: "DELETE", path: `/containers/${holderId}?force=true&v=true` });
      await docker(["volume", "rm", "-f", volume]);
      await rm(root, { recursive: true, force: true });
      await rm(foreignRoot, { recursive: true, force: true });
      await rm(dataRoot, { recursive: true, force: true });
    }
  },
  300_000,
);
