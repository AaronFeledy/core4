import { describe, expect, test } from "bun:test";
import { Layer } from "effect";

import { ENGINE_ID, PLUGIN_NAME, layer, layerWith, manifest } from "../src/index.ts";

describe("@lando/file-sync-mutagen manifest", () => {
  test("decodes against the SDK PluginManifest schema with the mutagen contribution", () => {
    expect(String(manifest.name)).toBe(String(PLUGIN_NAME));
    expect(manifest.api).toBe(4);
    expect(manifest.enabled).toBe(true);
    expect(manifest.contributes?.fileSyncEngines).toEqual([ENGINE_ID]);
  });

  test("exports a bundled engine layer", () => {
    expect(Layer.isLayer(layer)).toBe(true);
    expect(Layer.isLayer(layerWith())).toBe(true);
  });
});
