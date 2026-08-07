import { describe, expect, test } from "bun:test";

import { Schema } from "effect";

import { definePlugin } from "@lando/sdk/plugins";
import { PluginManifest } from "@lando/sdk/schema";

import {
  type LoadedPluginContribution,
  mergeLoadedPluginSources,
} from "@lando/engine/plugins/contribution-graph";
import { systemPluginsFromModules } from "@lando/engine/plugins/plugin-discovery";

const loaded = (source: LoadedPluginContribution["source"], version: string): LoadedPluginContribution => {
  const manifest = Schema.decodeSync(PluginManifest)({
    name: "@example/shared",
    version,
    api: 4,
  });
  return { source, manifest, entry: definePlugin({ name: manifest.name, manifest }) };
};

describe("plugin contribution source merge", () => {
  test("uses bundled then system then user then app then explicit identity precedence", () => {
    // Given
    const groups = [
      [loaded("bundled", "1.0.0")],
      [loaded("system", "2.0.0")],
      [loaded("user", "3.0.0")],
      [loaded("app", "4.0.0")],
      [loaded("explicit", "5.0.0")],
    ];

    // When
    const merged = mergeLoadedPluginSources(groups, []);

    // Then
    expect(merged).toHaveLength(1);
    expect(merged[0]?.source).toBe("explicit");
    expect(merged[0]?.manifest.version).toBe("5.0.0");
  });

  test("applies disable after every source override", () => {
    // Given
    const groups = [[loaded("bundled", "1.0.0")], [loaded("explicit", "5.0.0")]];

    // When
    const merged = mergeLoadedPluginSources(groups, ["@example/shared"]);

    // Then
    expect(merged).toEqual([]);
  });

  test("labels statically imported modules as bundled rather than system", () => {
    // Given
    const module = loaded("bundled", "1.0.0").entry;
    if (module === undefined) throw new Error("Expected a loaded bundled plugin module.");

    // When
    const [plugin] = systemPluginsFromModules([module]);

    // Then
    expect(plugin?.source).toBe("bundled");
  });
});
