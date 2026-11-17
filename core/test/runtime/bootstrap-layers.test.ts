import { describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { BOOTSTRAP_RANK } from "@lando/sdk/schema";

const repoRoot = resolve(import.meta.dirname, "../../..");
const layersDir = resolve(repoRoot, "core/src/runtime/layers");
const runtimeLayerPath = resolve(repoRoot, "core/src/runtime/layer.ts");
const countOccurrences = (source: string, target: string): number => source.split(target).length - 1;

describe("bootstrap layers", () => {
  test("ships one module for every BootstrapLevel", async () => {
    const files = await readdir(layersDir);
    const expected = [
      ...Object.keys(BOOTSTRAP_RANK).map((level) => `${level}.ts`),
      "generation.ts",
      "index.ts",
    ].sort();

    expect(files.toSorted()).toEqual(expected);
  });

  test("runtime layer factory consumes the layers module rather than composing layers", async () => {
    const source = await readFile(runtimeLayerPath, "utf8");

    expect(source).toContain("./layers/index");
    expect(source).not.toContain("Layer.mergeAll(");
    expect(source).not.toContain("Layer.provide(");
  });

  test("commands+ tiers inherit one command registry and install one subscriber runtime", async () => {
    // Given: every tracked bootstrap module from minimal through scratch.
    const minimal = await readFile(resolve(layersDir, "minimal.ts"), "utf8");
    const plugins = await readFile(resolve(layersDir, "plugins.ts"), "utf8");
    const commands = await readFile(resolve(layersDir, "commands.ts"), "utf8");
    const tooling = await readFile(resolve(layersDir, "tooling.ts"), "utf8");
    const provider = await readFile(resolve(layersDir, "provider.ts"), "utf8");
    const app = await readFile(resolve(layersDir, "app.ts"), "utf8");
    const global = await readFile(resolve(layersDir, "global.ts"), "utf8");
    const scratch = await readFile(resolve(layersDir, "scratch.ts"), "utf8");

    // When: command-registry and subscriber-runtime composition is inspected.
    const subscriberInstall =
      "SubscriberRuntimeLayer.layerWithPrivateFileAccess(\n    bundledPluginModules(),\n    BUILT_IN_COMMAND_IDS,\n  )";
    const commandRegistryInstall = "CommandRegistryLayer.layer";

    // Then: pre-command tiers install neither command subscribers nor a command registry.
    for (const source of [minimal, plugins]) {
      expect(countOccurrences(source, subscriberInstall)).toBe(0);
      expect(countOccurrences(source, commandRegistryInstall)).toBe(0);
    }

    // Then: the commands tier installs the registry and subscriber runtime exactly once.
    expect(commands).toContain("export const makeCommandsBootstrapBaseLayer");
    expect(countOccurrences(commands, commandRegistryInstall)).toBe(1);
    expect(countOccurrences(commands, subscriberInstall)).toBe(1);

    // Then: later tiers build on the commands base without reinstalling the registry.
    for (const source of [tooling, provider]) {
      expect(countOccurrences(source, "makeCommandsBootstrapBaseLayer(inputs)")).toBe(1);
      expect(countOccurrences(source, commandRegistryInstall)).toBe(0);
      expect(countOccurrences(source, subscriberInstall)).toBe(1);
    }

    // Then: the app tier builds on the provider base and installs subscribers once.
    expect(countOccurrences(app, "makeProviderBootstrapBaseLayer(inputs)")).toBe(1);
    expect(countOccurrences(app, commandRegistryInstall)).toBe(0);
    expect(countOccurrences(app, subscriberInstall)).toBe(1);

    // Then: global and scratch build on the provider layer without a second registry or subscriber.
    for (const source of [global, scratch]) {
      expect(countOccurrences(source, "makeProviderBootstrapLayer(inputs)")).toBe(1);
      expect(countOccurrences(source, commandRegistryInstall)).toBe(0);
      expect(countOccurrences(source, subscriberInstall)).toBe(0);
    }
  });

  test("plugins bootstrap installs the config translator registry over the contribution graph", async () => {
    // Given: the minimal and plugins tiers.
    const minimal = await readFile(resolve(layersDir, "minimal.ts"), "utf8");
    const plugins = await readFile(resolve(layersDir, "plugins.ts"), "utf8");

    // Then: only the plugins tier constructs the registry, fed by the same graph the plugin registry sees.
    expect(minimal).not.toContain("ConfigTranslatorRegistryLayer.layerWith");
    expect(countOccurrences(plugins, "ConfigTranslatorRegistryLayer.layerWith(bundledPluginModules())")).toBe(
      1,
    );
    expect(plugins).toContain(
      "const configTranslatorRegistryLayer = ConfigTranslatorRegistryLayer.layerWith(bundledPluginModules()).pipe(\n    Layer.provide(Layer.merge(minimalRuntimeLayer, contributionGraphLayer)),",
    );
    expect(plugins).toContain("configTranslatorRegistryLayer,");
  });

  test("provider bootstrap wires the default UrlScanner", async () => {
    const provider = await readFile(resolve(layersDir, "provider.ts"), "utf8");

    expect(provider).toContain(
      "const urlScannerLayer = ProviderUrlScanner.layer.pipe(\n    Layer.provide(Layer.mergeAll(providerRegistryLayer, commandsRuntimeLayer)),",
    );
    expect(countOccurrences(provider, "urlScannerLayer,")).toBe(1);
  });
});
