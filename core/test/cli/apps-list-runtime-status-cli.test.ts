import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { Schema } from "effect";

import { makeLandoPaths } from "@lando/paths";

import { AppsListResultSchema, appliedPlansDirectory } from "../../src/cli/commands/list.ts";

for (const state of ["running", "exited"] as const) {
  test.skipIf(process.platform === "win32")(
    `source CLI reports runtime status when the fake API is ${state}`,
    async () => {
      // Given isolated Lando roots and a fake managed socket, never a real provider.
      const root = await mkdtemp(join(tmpdir(), "lando-list-cli-"));
      const paths = makeLandoPaths({
        userDataRoot: join(root, "data"),
        userCacheRoot: join(root, "cache"),
        userConfRoot: join(root, "conf"),
      });
      const server = createServer((request, response) => {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify(
            request.url?.startsWith("/volumes")
              ? { Volumes: [] }
              : [
                  {
                    State: state,
                    Labels: {
                      "dev.lando.app": "retained",
                      "dev.lando.provider": "lando",
                      "dev.lando.service": "web",
                    },
                  },
                ],
          ),
        );
      });
      try {
        const dir = appliedPlansDirectory(paths.roots.userDataRoot);
        await mkdir(dir, { recursive: true });
        await mkdir(dirname(paths.providerSocketPath), { recursive: true });
        await writeFile(
          join(dir, "retained.json"),
          JSON.stringify({
            id: "retained",
            root,
            provider: "lando",
            services: { web: {} },
          }),
        );
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(paths.providerSocketPath, resolve);
        });

        // When the real source dispatcher emits machine output.
        const child = Bun.spawn(
          [process.execPath, join(import.meta.dir, "../../bin/lando.ts"), "apps:list", "--format=json"],
          {
            cwd: root,
            env: {
              ...process.env,
              LANDO_USER_DATA_ROOT: paths.roots.userDataRoot,
              LANDO_USER_CACHE_ROOT: paths.roots.userCacheRoot,
              LANDO_USER_CONF_ROOT: paths.roots.userConfRoot,
              LANDO_SYSTEM_PLUGIN_ROOT: join(root, "system-plugins"),
              DOCKER_HOST: `unix://${paths.providerSocketPath}`,
              XDG_RUNTIME_DIR: root,
            },
            stdout: "pipe",
            stderr: "pipe",
            signal: AbortSignal.timeout(20_000),
          },
        );
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);

        // Then the registered result schema preserves the runtime status in the envelope.
        expect(exitCode).toBe(0);
        expect(stderr).toBe("");
        const envelope = Schema.decodeUnknownSync(
          Schema.fromJsonString(
            Schema.Struct({
              result: AppsListResultSchema,
            }),
          ),
        )(stdout);
        expect(envelope.result.apps).toMatchObject([
          {
            appId: "retained",
            status: state === "running" ? "active" : "stopped",
          },
        ]);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(root, { recursive: true, force: true });
      }
    },
    30_000,
  );
}

const runSourceAppsList = async (
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../../bin/lando.ts"), ...args], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
    signal: AbortSignal.timeout(20_000),
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
};

test.skipIf(process.platform === "win32")(
  "source CLI --status filters the same runtime inventory for json and jq",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-list-cli-status-"));
    const paths = makeLandoPaths({
      userDataRoot: join(root, "data"),
      userCacheRoot: join(root, "cache"),
      userConfRoot: join(root, "conf"),
    });
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify(
          request.url?.startsWith("/volumes")
            ? { Volumes: [] }
            : [
                {
                  State: "running",
                  Labels: {
                    "dev.lando.app": "retained",
                    "dev.lando.provider": "lando",
                    "dev.lando.service": "web",
                  },
                },
              ],
        ),
      );
    });
    try {
      const dir = appliedPlansDirectory(paths.roots.userDataRoot);
      await mkdir(dir, { recursive: true });
      await mkdir(dirname(paths.providerSocketPath), { recursive: true });
      await writeFile(
        join(dir, "retained.json"),
        JSON.stringify({
          id: "retained",
          name: "retained",
          root,
          provider: "lando",
          services: { web: {} },
        }),
      );
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(paths.providerSocketPath, resolve);
      });
      const env = {
        ...process.env,
        LANDO_USER_DATA_ROOT: paths.roots.userDataRoot,
        LANDO_USER_CACHE_ROOT: paths.roots.userCacheRoot,
        LANDO_USER_CONF_ROOT: paths.roots.userConfRoot,
        LANDO_SYSTEM_PLUGIN_ROOT: join(root, "system-plugins"),
        DOCKER_HOST: `unix://${paths.providerSocketPath}`,
        XDG_RUNTIME_DIR: root,
      };

      const active = await runSourceAppsList(["apps:list", "--status=active", "--format=json"], env, root);
      expect(active.exitCode).toBe(0);
      expect(active.stderr).toBe("");
      const activeEnvelope = Schema.decodeUnknownSync(
        Schema.fromJsonString(Schema.Struct({ result: AppsListResultSchema })),
      )(active.stdout);
      expect(activeEnvelope.result.apps).toMatchObject([
        { appId: "retained", status: "active", appRoot: root },
      ]);

      const stopped = await runSourceAppsList(["list", "--status", "stopped", "--format=json"], env, root);
      expect(stopped.exitCode).toBe(0);
      const stoppedEnvelope = Schema.decodeUnknownSync(
        Schema.fromJsonString(Schema.Struct({ result: AppsListResultSchema })),
      )(stopped.stdout);
      expect(stoppedEnvelope.result.apps).toEqual([]);

      const both = await runSourceAppsList(
        ["apps:list", "--status", "active", "--status", "stopped", "--format=json"],
        env,
        root,
      );
      expect(both.exitCode).toBe(0);
      const bothEnvelope = Schema.decodeUnknownSync(
        Schema.fromJsonString(Schema.Struct({ result: AppsListResultSchema })),
      )(both.stdout);
      expect(bothEnvelope.result.apps).toMatchObject([{ appId: "retained", status: "active" }]);

      const jqRoot = await runSourceAppsList(
        ["list", "--jq", '.result.apps[] | select(.appName=="retained") | .appRoot'],
        env,
        root,
      );
      expect(jqRoot.exitCode).toBe(0);
      expect(jqRoot.stdout.trim()).toBe(root);

      const rejected = await runSourceAppsList(["apps:list", "--status", "running"], env, root);
      expect(rejected.exitCode).toBe(2);
      expect(rejected.stderr).toContain("--status");
      expect(rejected.stderr).toContain("active, stopped, unknown");
      expect(rejected.stderr).not.toContain("running");

      const filteredEmpty = await runSourceAppsList(["list", "--status=stopped"], env, root);
      expect(filteredEmpty.exitCode).toBe(0);
      expect(filteredEmpty.stdout).toContain("No Lando apps match the filters.");
      expect(filteredEmpty.stdout).not.toContain("No Lando apps applied on this host.");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);
