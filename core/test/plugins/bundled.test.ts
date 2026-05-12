import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";
import { Context, Effect, Layer } from "effect";

import { BUNDLED_PLUGINS } from "../../src/plugins/bundled.ts";
import { PluginRegistry, PluginRegistryLive } from "../../src/plugins/registry.ts";

const EXPECTED_BUNDLED_PLUGIN_NAMES: ReadonlyArray<string> = [
  "@lando/provider-lando",
  "@lando/provider-docker",
  "@lando/service-lando",
  "@lando/logger-pretty",
];

const bundledModulePath = resolve(import.meta.dirname, "../../src/plugins/bundled.ts");
const generatorPath = resolve(import.meta.dirname, "../../../scripts/build-bundled-plugins.ts");

describe("BUNDLED_PLUGINS", () => {
  test("exports all MVP bundled plugins with layer and manifest stubs", () => {
    expect(BUNDLED_PLUGINS.map((plugin) => plugin.name)).toEqual([...EXPECTED_BUNDLED_PLUGIN_NAMES]);

    for (const plugin of BUNDLED_PLUGINS) {
      expect(Layer.isLayer(plugin.layer)).toBe(true);
      expect(plugin.manifest).toMatchObject({
        name: plugin.name,
        api: 4,
        bundled: true,
      });
    }
  });

  test("generated bundled plugin module is idempotent", async () => {
    const before = await readFile(bundledModulePath, "utf8");
    const proc = Bun.spawnSync([process.execPath, generatorPath], {
      cwd: resolve(import.meta.dirname, "../../.."),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).toBe(0);
    const after = await readFile(bundledModulePath, "utf8");

    expect(after).toBe(before);
  });

  test("PluginRegistryLive lists and loads only bundled manifests", async () => {
    const context = await Effect.runPromise(Effect.scoped(Layer.build(PluginRegistryLive)));
    const registry = Context.get(context, PluginRegistry);
    const manifests = await Effect.runPromise(registry.list);
    const manifestNames: ReadonlyArray<string> = manifests.map((manifest) => String(manifest.name));
    expect(manifestNames).toEqual([...EXPECTED_BUNDLED_PLUGIN_NAMES]);

    const manifest = await Effect.runPromise(registry.load("@lando/provider-docker"));
    const loadedName: string = String(manifest.name);
    expect(loadedName).toBe("@lando/provider-docker");

    const exit = await Effect.runPromiseExit(registry.load("@lando/not-bundled"));
    expect(exit._tag).toBe("Failure");
  });
});
