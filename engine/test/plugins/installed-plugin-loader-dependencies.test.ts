import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { PluginLoadError } from "@lando/sdk/errors";
import { Effect } from "effect";

import { loadInstalledPlugin } from "../../src/plugins/installed-plugin-loader.ts";

test("resolves deferred dependencies from a linked plugin's physical package", async () => {
  // Given an isolated workspace with a real installed dependency above its plugin,
  // and a registry link outside that dependency's resolution ancestry.
  const root = await realpath(await mkdtemp(join(tmpdir(), "lando-linked-dependency-")));
  try {
    const workspace = join(root, "workspace");
    const packageRoot = join(workspace, "packages", "plugin");
    const linkedRoot = join(root, "registry", "plugin");
    await mkdir(packageRoot, { recursive: true });
    await mkdir(join(workspace, "node_modules"));
    await mkdir(dirname(linkedRoot));
    await symlink(
      dirname(Bun.resolveSync("semver/package.json", import.meta.dir)),
      join(workspace, "node_modules", "semver"),
      "junction",
    );
    await symlink(packageRoot, linkedRoot, "junction");
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({
        type: "module",
        landoPlugin: { name: "linked-dependency", version: "1.0.0", api: 4, entry: "./index.ts" },
      }),
    );
    await writeFile(
      join(packageRoot, "index.ts"),
      `
      export const inspect = () => import("./inspect.ts").then((module) => module.inspect());
    `,
    );
    await writeFile(
      join(packageRoot, "inspect.ts"),
      `
      import { valid } from "semver";
      import { Effect } from "effect";
      import { PluginLoadError } from "@lando/sdk/errors";
      export const inspect = () => ({ version: valid("1.2.3"), succeed: Effect.succeed, PluginLoadError });
    `,
    );

    // When the installed loader imports the registry link and the plugin runs later.
    const loaded = await loadInstalledPlugin(linkedRoot);
    const inspect = loaded.module?.inspect;
    if (typeof inspect !== "function") throw new TypeError("Plugin must export inspect");
    const result: unknown = await inspect();

    // Then ordinary packages resolve physically while SDK/Effect retain host identity.
    expect(result).toEqual({ version: "1.2.3", succeed: Effect.succeed, PluginLoadError });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
