import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventService, type LandoEvent } from "@lando/sdk/services";
import { Effect } from "effect";
import { pluginPublish } from "../../src/cli/commands/plugin-publish";
import { parseNpmRegistryConfig } from "../../src/recipes/npm-registry-config";
import { makeTestEventService } from "../../src/testing/test-runtime-events";
import { withProcess } from "../_support/process-runner";

const username = "publish-user-canary";
const password = "publish-password-canary";
const token = "separate-publish-token-canary";

const writePlugin = async (root: string, registry: string | undefined, fresh: boolean) => {
  const name = "@acme/lando-plugin-validation";
  const pkg = {
    name,
    version: "1.0.0",
    type: "module",
    exports: { ".": "./src/index.ts" },
    landoPlugin: { name, version: "1.0.0", api: 4, entry: "src/index.ts" },
    ...(registry === undefined ? {} : { publishConfig: { registry } }),
  };
  await fs.mkdir(join(root, "src"));
  await fs.writeFile(join(root, "package.json"), JSON.stringify(pkg));
  await fs.writeFile(join(root, "src/index.ts"), "export {};\n");
  if (fresh) {
    await fs.mkdir(join(root, "dist"));
    await fs.writeFile(join(root, "dist/package.json"), JSON.stringify({ name, version: "1.0.0" }));
    for (const file of ["index.js", "index.d.ts"]) {
      await fs.writeFile(join(root, "dist", file), "export {};\n");
    }
    await fs.utimes(join(root, "src/index.ts"), 1, 1);
    await fs.utimes(join(root, "package.json"), 1, 1);
  }
};

for (const userinfo of [`${username}:${password}`, username, `:${password}`, "%61lice:%73ecret"]) {
  const registry = `https://${userinfo}@registry.example/`;
  const inputs = [
    { source: "option", registry, packageRegistry: undefined, npmrc: "" },
    { source: "package", registry: undefined, packageRegistry: registry, npmrc: "" },
    { source: "npm", registry: undefined, packageRegistry: undefined, npmrc: `registry=${registry}\n` },
  ];
  for (const input of inputs) {
    test.each([false, true])(
      `rejects ${input.source} registry userinfo ${userinfo} before preparation (fresh=%s)`,
      async (fresh) => {
        // Given a publishable plugin and a matching, separately configured Bearer token.
        const root = await fs.mkdtemp(join(tmpdir(), "lando-publish-validation-"));
        try {
          await writePlugin(root, input.packageRegistry, fresh);
          const config = parseNpmRegistryConfig(`${input.npmrc}//registry.example/:_authToken=${token}`);
          const events: LandoEvent[] = [];
          const spawns: (readonly string[])[] = [];
          const writes = spyOn(fs, "writeFile");
          const temporaryDirectories = spyOn(fs, "mkdtemp");
          try {
            // When publishing with tests enabled (including the stale build path).
            const exit = await Effect.runPromiseExit(
              pluginPublish({
                cwd: root,
                ...(input.registry === undefined ? {} : { registry: input.registry }),
                npmConfig: async () => config,
              }).pipe(
                withProcess(async ({ cmd }) => {
                  spawns.push(cmd);
                  return { exitCode: 0 };
                }),
                Effect.provideService(EventService, makeTestEventService(events)),
              ),
            );

            // Then rejection precedes any child, config creation, or observable publication event.
            expect({
              exit: exit._tag,
              spawns: spawns.length,
              writes: writes.mock.calls.length,
              temporaryDirectories: temporaryDirectories.mock.calls.length,
              events: events.length,
            }).toEqual({
              exit: "Failure",
              spawns: 0,
              writes: 0,
              temporaryDirectories: 0,
              events: 0,
            });
            const output = JSON.stringify({ exit, events, spawns });
            expect(output).toContain("PluginPublishValidationError");
            for (const secret of [username, password, token, "alice", "secret", "%61lice", "%73ecret"])
              expect(output).not.toContain(secret);
            for (const field of ["_authToken", "_auth", "username", "_password"])
              expect(output).toContain(field);
          } finally {
            writes.mockRestore();
            temporaryDirectories.mockRestore();
          }
        } finally {
          await fs.rm(root, { recursive: true, force: true });
        }
      },
    );
  }
}

test.each(["http", "https"])("publishes to plain %s registry with separate auth", async (protocol) => {
  // Given a fresh plugin with a separately configured credential.
  const root = await fs.mkdtemp(join(tmpdir(), "lando-publish-validation-"));
  try {
    await writePlugin(root, undefined, true);
    const registry = `${protocol}://registry.example/`;
    const spawns: (readonly string[])[] = [];

    // When publishing to a registry without userinfo.
    const result = await Effect.runPromise(
      pluginPublish({
        cwd: root,
        registry,
        noTest: true,
        npmConfig: async () => parseNpmRegistryConfig(`//registry.example/:_authToken=${token}`),
      }).pipe(
        withProcess(async ({ cmd, env }) => {
          spawns.push(cmd);
          expect(env.BUN_CONFIG_TOKEN).toBe(token);
          return { exitCode: 0 };
        }),
      ),
    );

    // Then publication still uses the resolved registry and keeps auth out of argv.
    expect(result.published).toBe(true);
    expect(spawns).toHaveLength(1);
    expect(spawns[0]).toContain(registry);
    expect(JSON.stringify(spawns)).not.toContain(token);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
