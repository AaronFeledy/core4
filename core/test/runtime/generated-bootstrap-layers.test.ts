import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import { BOOTSTRAP_RANK } from "@lando/sdk/schema";

const repoRoot = resolve(import.meta.dirname, "../../..");
const generatedLayersDir = resolve(repoRoot, "core/src/runtime/generated/layers");
const runtimeLayerPath = resolve(repoRoot, "core/src/runtime/layer.ts");
const countOccurrences = (source: string, target: string): number => source.split(target).length - 1;

describe("generated bootstrap layers", () => {
  test("commits one generated module for every BootstrapLevel", async () => {
    const files = await readdir(generatedLayersDir);
    const expected = [...Object.keys(BOOTSTRAP_RANK).map((level) => `${level}.ts`), "index.ts"].sort();

    expect(files.toSorted()).toEqual(expected);
  });

  test("runtime layer factory consumes generated bootstrap composition", async () => {
    const source = await readFile(runtimeLayerPath, "utf8");

    expect(source).toContain("./generated/layers/index");
    expect(source).not.toContain("Layer.mergeAll(");
    expect(source).not.toContain("Layer.provide(");
  });

  test("commands+ tiers inherit one command registry and install one subscriber runtime", async () => {
    // Given: every generated bootstrap module from minimal through scratch.
    const minimal = await readFile(resolve(generatedLayersDir, "minimal.ts"), "utf8");
    const plugins = await readFile(resolve(generatedLayersDir, "plugins.ts"), "utf8");
    const commands = await readFile(resolve(generatedLayersDir, "commands.ts"), "utf8");
    const tooling = await readFile(resolve(generatedLayersDir, "tooling.ts"), "utf8");
    const provider = await readFile(resolve(generatedLayersDir, "provider.ts"), "utf8");
    const app = await readFile(resolve(generatedLayersDir, "app.ts"), "utf8");
    const global = await readFile(resolve(generatedLayersDir, "global.ts"), "utf8");
    const scratch = await readFile(resolve(generatedLayersDir, "scratch.ts"), "utf8");

    // When: command-registry and subscriber-runtime composition is inspected.
    const subscriberInstall = "makeSubscriberRuntimeLive(bundledPluginModules(), BUILT_IN_COMMAND_IDS)";
    const commandRegistryInstall = "CommandRegistryLive.pipe(";

    // Then: pre-command tiers install neither command subscribers nor a command registry.
    for (const source of [minimal, plugins]) {
      expect(countOccurrences(source, subscriberInstall)).toBe(0);
      expect(countOccurrences(source, commandRegistryInstall)).toBe(0);
    }

    expect(minimal).not.toContain("makePluginRegistryLive");
    expect(commands).toContain("makeEngineLandofileServiceLive");
    expect(commands).toContain('from "@lando/engine/services/landofile-live"');
    expect(commands).toContain("makeEngineLandofileServiceLive(landofileRuntimeInputs())");
    expect(commands).toContain("export const makeCommandsBootstrapBaseLayer");
    expect(countOccurrences(commands, commandRegistryInstall)).toBe(1);
    expect(countOccurrences(commands, subscriberInstall)).toBe(1);

    for (const source of [tooling, provider]) {
      expect(countOccurrences(source, "makeCommandsBootstrapBaseLayer(inputs)")).toBe(1);
      expect(countOccurrences(source, commandRegistryInstall)).toBe(0);
      expect(countOccurrences(source, subscriberInstall)).toBe(1);
    }

    expect(countOccurrences(app, "makeProviderBootstrapBaseLayer(inputs)")).toBe(1);
    expect(countOccurrences(app, commandRegistryInstall)).toBe(0);
    expect(countOccurrences(app, subscriberInstall)).toBe(1);

    for (const source of [global, scratch]) {
      expect(countOccurrences(source, "makeProviderBootstrapLayer(inputs)")).toBe(1);
      expect(countOccurrences(source, commandRegistryInstall)).toBe(0);
      expect(countOccurrences(source, subscriberInstall)).toBe(0);
    }
  });

  test("provider bootstrap wires the default UrlScanner", async () => {
    const provider = await readFile(resolve(generatedLayersDir, "provider.ts"), "utf8");

    expect(provider).toContain("UrlScannerLive");
    expect(provider).toContain("Layer.provide(Layer.mergeAll(runtimeProviderLive, pluginsRuntimeLive))");
    expect(provider).toContain("urlScannerLive");
  });

  test("app bootstrap does not import a file-sync plugin package", async () => {
    // Given: the generated app bootstrap source.
    const app = await readFile(resolve(generatedLayersDir, "app.ts"), "utf8");

    // When: its imports are inspected.
    const importsMutagenPackage = app.includes('from "@lando/file-sync-mutagen"');

    // Then: file-sync resolution stays behind the core plugin-module seam.
    expect(importsMutagenPackage).toBe(false);
  });

  test("generated layers resolve composition through engine accessors", async () => {
    // Given: every generated bootstrap layer source.
    const sources = await Promise.all(
      (await readdir(generatedLayersDir))
        .filter((file) => file.endsWith(".ts"))
        .map((file) => readFile(resolve(generatedLayersDir, file), "utf8")),
    );

    // When: generated imports and composition reads are inspected.
    const combined = sources.join("\n");

    // Then: no layer reaches core's static plugin table or host Landofile value directly.
    expect(combined).not.toContain("plugins/generated/bundled");
    expect(combined).not.toContain("coreLandofileRuntimeInputs");
    expect(combined).toContain("bundledPluginModules()");
    expect(combined).toContain("landofileRuntimeInputs()");
  });
});
