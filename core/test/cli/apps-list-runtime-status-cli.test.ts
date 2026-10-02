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
          Schema.parseJson(
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
