import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { expect, test } from "bun:test";
import { Effect } from "effect";

import type { PluginManifest } from "@lando/sdk/schema";

import { writePluginCommandCacheStrict } from "../../src/cache/command-index-writer.ts";
import { decodePluginCommandIndex } from "../../src/cache/command-index.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const fixtureFiles = [
  "package.json",
  "biome.json",
  "core/build.config.ts",
  "scripts/_codegen-output.ts",
  "scripts/build-bundled-plugins.ts",
] as const;
const fixturePluginName = "@lando/command-cache-fixture";
const fixtureCommandId = "fixture:ship-proof";

type BundledPluginModule = {
  readonly manifest: PluginManifest;
};

const isBundledPluginTable = (
  value: unknown,
): value is { readonly BUNDLED_PLUGIN_MODULES: ReadonlyArray<BundledPluginModule> } =>
  typeof value === "object" &&
  value !== null &&
  "BUNDLED_PLUGIN_MODULES" in value &&
  Array.isArray(value.BUNDLED_PLUGIN_MODULES);

const runGenerator = (root: string): void => {
  const result = Bun.spawnSync([process.execPath, resolve(root, "scripts/build-bundled-plugins.ts")], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toMatchObject({ exitCode: 0 });
};

const readBundledModules = async (generatedPath: string): Promise<ReadonlyArray<BundledPluginModule>> => {
  const imported: unknown = await import(pathToFileURL(generatedPath).href);
  if (!isBundledPluginTable(imported)) throw new TypeError("bundled plugin generator exports are incomplete");
  return imported.BUNDLED_PLUGIN_MODULES;
};

test("plugin-command cache omits a bundled command after ship-list removal and regeneration", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-bundled-command-cache-"));
  try {
    await Promise.all(
      fixtureFiles.map(async (path) => {
        const destination = resolve(root, path);
        await mkdir(dirname(destination), { recursive: true });
        await cp(resolve(repoRoot, path), destination);
      }),
    );
    await symlink(resolve(repoRoot, "node_modules"), resolve(root, "node_modules"), "dir");
    await symlink(resolve(repoRoot, "sdk"), resolve(root, "sdk"), "dir");

    const fixturePluginPath = resolve(root, "fixtures/command-plugin.ts");
    await mkdir(dirname(fixturePluginPath), { recursive: true });
    await writeFile(
      fixturePluginPath,
      `export const manifest = {
  name: "${fixturePluginName}",
  version: "0.0.0",
  api: 4,
  bootstrap: "app",
  contributes: { commands: ["${fixtureCommandId}"] },
};
export const plugin = { name: manifest.name, manifest };
`,
      "utf8",
    );

    const buildConfigPath = resolve(root, "core/build.config.ts");
    const originalBuildConfig = await readFile(buildConfigPath, "utf8");
    await writeFile(
      buildConfigPath,
      originalBuildConfig.replace(
        "bundledPlugins: [",
        `bundledPlugins: [\n    { name: ${JSON.stringify(fixturePluginPath)}, path: "fixtures/command-plugin" },`,
      ),
      "utf8",
    );
    const generatedPath = resolve(root, "core/src/plugins/generated/bundled.ts");
    runGenerator(root);
    const includedGeneratedPath = resolve(root, "core/src/plugins/generated/bundled-included.ts");
    await cp(generatedPath, includedGeneratedPath);
    const includedModules = await readBundledModules(includedGeneratedPath);
    const includedCachePath = await Effect.runPromise(
      writePluginCommandCacheStrict({ modules: includedModules, cacheRoot: resolve(root, "cache-included") }),
    );
    const included = decodePluginCommandIndex(new Uint8Array(await readFile(includedCachePath)));
    expect(included?.pluginNames).toContain(fixturePluginName);
    expect(included?.entries.map((entry) => entry.id)).toContain(fixtureCommandId);

    // When
    await writeFile(buildConfigPath, originalBuildConfig, "utf8");
    runGenerator(root);
    const removedGeneratedPath = resolve(root, "core/src/plugins/generated/bundled-removed.ts");
    await cp(generatedPath, removedGeneratedPath);
    const removedModules = await readBundledModules(removedGeneratedPath);
    const removedCachePath = await Effect.runPromise(
      writePluginCommandCacheStrict({ modules: removedModules, cacheRoot: resolve(root, "cache-removed") }),
    );
    const removed = decodePluginCommandIndex(new Uint8Array(await readFile(removedCachePath)));

    // Then
    expect(removed?.pluginNames).not.toContain(fixturePluginName);
    expect(removed?.entries.map((entry) => entry.id)).not.toContain(fixtureCommandId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
