import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeProviderDataPlane, sqliteHelperImage } from "@lando/container-runtime/data-plane";
import { makeDockerApiClient } from "@lando/container-runtime/docker/api-client";
import { standaloneSecretsRedactor } from "@lando/container-runtime/redact";
import { makeLandoPaths } from "@lando/paths";
import { AbsolutePath, AppId, type AppPlan, ProviderId, planAppIdentity } from "@lando/sdk/schema";
import { StateStore } from "@lando/sdk/services";
import * as DiskStateStore from "@lando/state-store/service";
import { DateTime, Effect } from "effect";
import type { SqlCommandDeps } from "../src/command-types.ts";
import { executeSqliteCommand } from "../src/sqlite-execute.ts";
import { sqliteSnapshotStore } from "../src/sqlite-path.ts";
import { cleanupSqlTestDeps, makeSqlTestDeps } from "./support/fakes.ts";
import { openSqliteSidecar } from "./support/sqlite-sidecar.ts";

const socket = process.env.LANDO_TEST_DOCKER_SOCKET;
test.skipIf(socket === undefined)(
  "SQLite borrows a running accelerated app volume and initializes a missing database without host repair",
  async () => {
    if (socket === undefined) throw new Error("LANDO_TEST_DOCKER_SOCKET required");
    const endpoint = socket.startsWith("unix://") ? socket : `unix://${socket}`;
    const root = await mkdtemp(join(tmpdir(), "lando-sqlite-borrowed-"));
    const volume = `sqlite-app-${crypto.randomUUID()}`;
    let containerId = "";
    const docker = async (args: readonly string[]) => {
      const child = Bun.spawn(["docker", ...args], {
        env: { ...process.env, DOCKER_HOST: endpoint },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if (exitCode !== 0) throw new Error(`Docker fixture failed: ${stderr}`);
      return stdout.trim();
    };
    const harness = makeSqlTestDeps({ password: "unused" });
    try {
      await docker(["pull", sqliteHelperImage.ref]);
      await docker(["volume", "create", volume]);
      await docker([
        "run",
        "--rm",
        "--user",
        "0:0",
        "--entrypoint",
        "sh",
        "-v",
        `${volume}:/app`,
        sqliteHelperImage.ref,
        "-c",
        "chown 1001:1001 /app",
      ]);
      containerId = await docker([
        "run",
        "-d",
        "--user",
        "1001:1001",
        "--entrypoint",
        "sh",
        "-v",
        `${volume}:/app`,
        sqliteHelperImage.ref,
        "-c",
        "sleep 3600",
      ]);
      const inspect = () =>
        Effect.tryPromise(async () => {
          const fields = (
            await docker(["inspect", "--format", "{{.Id}}|{{.Image}}|{{.State.Running}}", containerId])
          ).split("|");
          const [id, imageIdentity, running] = fields;
          if (id === undefined || imageIdentity === undefined)
            throw new Error("Invalid Docker fixture identity");
          return {
            status: running === "true" ? ("running" as const) : ("stopped" as const),
            running: running === "true",
            containerId: id,
            imageIdentity,
          };
        });
      const redactor = standaloneSecretsRedactor({});
      const client = makeDockerApiClient(
        endpoint,
        { providerId: "docker", remediation: "Start Docker.", env: {}, redactor },
        { env: {} },
      );
      await Effect.runPromise(client.info);
      const plane = makeProviderDataPlane({
        providerId: "docker",
        api: client,
        capabilities: { volumeSnapshot: "none" },
        redactor,
      });
      const identity = planAppIdentity({ root: AbsolutePath.make(root) });
      const applied: AppPlan = {
        id: AppId.make("sqlite-borrowed"),
        name: "sqlite-borrowed",
        slug: "sqlite-borrowed",
        root: identity.appRoot,
        identity,
        provider: ProviderId.make("docker"),
        services: {},
        routes: [],
        stores: [],
        fileSync: [],
        extensions: {},
        metadata: { resolvedAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z"), source: "fixture", runtime: 4 },
      };
      const paths = makeLandoPaths({
        userConfRoot: join(root, "conf"),
        userDataRoot: join(root, "data"),
        userCacheRoot: join(root, "cache"),
        env: {},
      });
      const stateStore = await Effect.runPromise(StateStore.pipe(Effect.provide(DiskStateStore.layer)));
      const target = {
        kind: "file",
        name: "appserver",
        type: "php:8.3",
        family: "sqlite",
        path: "missing/nested/site.sqlite",
      } as const;
      const service = {
        name: target.name,
        type: target.type,
        environment: {},
        extensions: {},
        storage: [],
        sqlite: { path: target.path },
        mounts: [
          {
            type: "bind" as const,
            source: root,
            target: "/app",
            role: "app" as const,
            readOnly: false,
            realization: "accelerated" as const,
          },
        ],
      };
      const deps: SqlCommandDeps = {
        ...harness.deps,
        inspect,
        plan: { ...harness.deps.plan, root, identity, services: { appserver: service } },
        suspend: (_, expected) =>
          Effect.tryPromise(async () => {
            expect(expected.containerId).toBe(containerId);
            await docker(["stop", "-t", "1", containerId]);
          }),
        resume: (_, expected) =>
          Effect.tryPromise(async () => {
            expect(expected.containerId).toBe(containerId);
            await docker(["start", containerId]);
          }),
        sqlite: {
          applied,
          inspect,
          privateFileAccess: harness.deps.privateFileAccess,
          run: (spec) => Effect.scoped(plane.run(spec)),
          pullArtifact: () => Effect.succeed({ digest: sqliteHelperImage.digest }),
          paths,
          stateStore,
        },
      };
      const input = join(root, "input.sql");
      await writeFile(input, "CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES('borrowed');");
      const imported = await Effect.runPromise(
        executeSqliteCommand(deps, { action: "import", yes: true, file: input }, target),
      );
      expect(imported.recoverySkipped).toBe("database-missing");
      expect(imported.recoverySnapshotId).toBeUndefined();
      expect((await Effect.runPromise(inspect())).running).toBe(true);
      expect(await Bun.file(join(root, target.path)).exists()).toBe(false);
      const exported = join(root, "output.sql");
      await Effect.runPromise(
        executeSqliteCommand(
          deps,
          { action: "export", yes: true, file: exported, compression: "none" },
          target,
        ),
      );
      expect(await Bun.file(exported).text()).toContain("borrowed");
      const snapshot = await Effect.runPromise(
        executeSqliteCommand(deps, { action: "snapshot", yes: true }, target),
      );
      const bucket = await Effect.runPromise(
        openSqliteSidecar(
          stateStore,
          join(paths.ownerSnapshotsDir(identity.ownerKey), sqliteSnapshotStore(target.path)),
          snapshot.snapshotId ?? "",
        ),
      );
      const info = await Effect.runPromise(bucket.get);
      if (info === null) throw new Error("Snapshot was not catalogued");
      const reset = await Effect.runPromise(
        executeSqliteCommand(deps, { action: "reset", yes: true }, target),
      );
      expect(reset.recoverySnapshotId).toBeString();
      await Effect.runPromise(
        executeSqliteCommand(
          { ...deps, resolveSnapshot: () => Effect.succeed(info) },
          { action: "restore", yes: true, snapshotId: info.id },
          target,
        ),
      );
      const content = await docker([
        "exec",
        containerId,
        "sqlite3",
        `/app/${target.path}`,
        "SELECT value FROM marker;",
      ]);
      expect(content).toBe("borrowed");
      expect((await Effect.runPromise(inspect())).running).toBe(true);
    } finally {
      if (containerId.length > 0) await docker(["rm", "-f", containerId]);
      await docker(["volume", "rm", "-f", volume]);
      cleanupSqlTestDeps();
      await rm(root, { recursive: true, force: true });
    }
  },
  240_000,
);
