import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { loadInstalledPlugin } from "@lando/engine/plugins/installed-plugin-loader";
import { importAuthorModule } from "@lando/landofile/author-modules";
import { PluginLoadError } from "@lando/sdk/errors";
import { Effect } from "effect";

import { pluginBuild } from "../../src/cli/commands/plugin-build.ts";

test("builds a standalone split artifact with lazy private dependencies and host peer identity", async () => {
  // Given a composite author project with a public operation and a lazy command.
  const root = await mkdtemp(join(tmpdir(), "lando-plugin-artifact-"));
  const marker = `lando-plugin-artifact-${root}`;
  try {
    const source = join(root, "author");
    await mkdir(join(source, "src"), { recursive: true });
    await symlink(
      resolve(import.meta.dir, "../../../node_modules"),
      join(source, "node_modules"),
      "junction",
    );
    await writeFile(
      join(source, "package.json"),
      JSON.stringify({
        name: "artifact-fixture",
        version: "1.0.0",
        type: "module",
        exports: { ".": "./src/index.ts", "./operations": "./src/operations.ts" },
        landoPlugin: { name: "artifact-fixture", version: "1.0.0", api: 4, entry: "./src/index.ts" },
        dependencies: { semver: "^7.8.5" },
        peerDependencies: { "@lando/sdk": "*", effect: "*" },
      }),
    );
    await writeFile(
      join(source, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          composite: true,
          strict: true,
          skipLibCheck: true,
          module: "ESNext",
          target: "ESNext",
          moduleResolution: "bundler",
          allowImportingTsExtensions: true,
          types: ["bun"],
        },
        include: ["src/**/*.ts"],
      }),
    );
    await writeFile(
      join(source, "src/index.ts"),
      `
      import { Errors } from "@lando/sdk";
      import { PluginLoadError } from "@lando/sdk/errors";
      import { Effect } from "effect";
      import { succeed } from "effect/Effect";
      export const peers = [Errors.PluginLoadError, PluginLoadError, Effect.succeed, succeed];
      export const loadCommand = () => import("./command.ts");
    `,
    );
    await writeFile(
      join(source, "src/command.ts"),
      `
      export const run = () => import("./implementation.ts").then((module) => module.inspect());
    `,
    );
    await writeFile(
      join(source, "src/implementation.ts"),
      `
      import { valid } from "semver";
      Reflect.set(globalThis, ${JSON.stringify(marker)}, true);
      export const inspect = () => valid("1.2.3");
    `,
    );
    await writeFile(join(source, "src/operations.ts"), 'export { inspect } from "./implementation.ts";\n');

    // When the shared builder emits an artifact relocated away from source and node_modules.
    const result = await Effect.runPromise(pluginBuild({ cwd: source }));
    expect(result.exitCode).toBe(0);
    const artifact = join(root, "installed");
    await cp(join(source, "dist"), artifact, { recursive: true });
    await rm(source, { recursive: true, force: true });
    const loaded = await loadInstalledPlugin(artifact);
    const loadCommand = loaded.module?.loadCommand;
    if (typeof loadCommand !== "function") throw new TypeError("Artifact must export loadCommand");
    const command: unknown = await loadCommand();

    // Then descriptor/help loading stays lazy, peers stay host-owned, and private code is portable.
    expect(loaded.manifest.entry).toBe("./index.js");
    expect(loaded.module?.peers).toEqual([PluginLoadError, PluginLoadError, Effect.succeed, Effect.succeed]);
    expect(Reflect.has(globalThis, marker)).toBe(false);
    if (
      typeof command !== "object" ||
      command === null ||
      !("run" in command) ||
      typeof command.run !== "function"
    ) {
      throw new TypeError("Artifact command must export run");
    }
    expect(await command.run()).toBe("1.2.3");
    const operations = await importAuthorModule(join(artifact, "operations.js"));
    if (
      typeof operations !== "object" ||
      operations === null ||
      !("inspect" in operations) ||
      typeof operations.inspect !== "function"
    ) {
      throw new TypeError("Artifact must export inspect");
    }
    expect(operations.inspect()).toBe("1.2.3");
  } finally {
    Reflect.deleteProperty(globalThis, marker);
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
