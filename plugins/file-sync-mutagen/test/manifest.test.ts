import { describe, expect, test } from "bun:test";
import { Layer } from "effect";

import { ENGINE_ID, PLUGIN_NAME, engine, makeEngineLayer, manifest } from "../src/index.ts";

describe("@lando/file-sync-mutagen manifest", () => {
  test("decodes against the SDK PluginManifest schema with the mutagen contribution", () => {
    expect(manifest.name).toBe(PLUGIN_NAME);
    expect(manifest.api).toBe(4);
    expect(manifest.enabled).toBe(true);
    expect(manifest.contributes?.fileSyncEngines).toEqual([ENGINE_ID]);
  });

  test("exports a bundled Live Layer", () => {
    expect(Layer.isLayer(engine)).toBe(true);
    expect(Layer.isLayer(makeEngineLayer())).toBe(true);
  });
});
