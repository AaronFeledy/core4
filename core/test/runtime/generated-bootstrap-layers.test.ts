import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import { BOOTSTRAP_RANK } from "@lando/sdk/schema";

const repoRoot = resolve(import.meta.dirname, "../../..");
const generatedLayersDir = resolve(repoRoot, "core/src/runtime/generated/layers");
const runtimeLayerPath = resolve(repoRoot, "core/src/runtime/layer.ts");

describe("generated bootstrap layers", () => {
  test("commits one generated module for every BootstrapLevel", async () => {
    const files = await readdir(generatedLayersDir);
    const expected = [...Object.keys(BOOTSTRAP_RANK).map((level) => `${level}.ts`), "index.ts"].sort();

    expect(files.toSorted()).toEqual(expected);
  });

  test("runtime layer factory consumes generated bootstrap composition", async () => {
    const source = await readFile(runtimeLayerPath, "utf8");

    expect(source).toContain("./generated/layers/index.ts");
    expect(source).not.toContain("Layer.mergeAll(");
    expect(source).not.toContain("Layer.provide(");
  });

  test("higher plugin-aware bootstrap tiers reuse deprecation-populated plugin layers", async () => {
    const tooling = await readFile(resolve(generatedLayersDir, "tooling.ts"), "utf8");
    const provider = await readFile(resolve(generatedLayersDir, "provider.ts"), "utf8");
    const global = await readFile(resolve(generatedLayersDir, "global.ts"), "utf8");
    const scratch = await readFile(resolve(generatedLayersDir, "scratch.ts"), "utf8");
    const app = await readFile(resolve(generatedLayersDir, "app.ts"), "utf8");

    expect(tooling).toContain("makePluginsBootstrapLayer(inputs)");
    expect(provider).toContain("makePluginsBootstrapLayer(inputs)");
    expect(global).toContain("makeProviderBootstrapLayer(inputs)");
    expect(scratch).toContain("makeProviderBootstrapLayer(inputs)");
    expect(app).toContain("makeProviderBootstrapLayer(inputs)");

    for (const source of [tooling, provider, global, scratch, app]) {
      expect(source).not.toContain("makePluginRegistryLive");
    }
  });

  test("provider bootstrap wires the default UrlScanner", async () => {
    const provider = await readFile(resolve(generatedLayersDir, "provider.ts"), "utf8");

    expect(provider).toContain("UrlScannerLive");
    expect(provider).toContain("Layer.provide(Layer.mergeAll(runtimeProviderLive, pluginsRuntimeLive))");
    expect(provider).toContain("urlScannerLive");
  });
});
