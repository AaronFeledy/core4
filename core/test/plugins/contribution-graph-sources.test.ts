import { describe, expect, test } from "bun:test";

import { Effect, Either, Schema } from "effect";

import { definePlugin } from "@lando/sdk/plugins";
import { PluginManifest } from "@lando/sdk/schema";

import {
  type LoadedPluginContribution,
  mergeLoadedPluginSources,
  pluginCommandCandidates,
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

  test("projects executable command loaders from a real plugin descriptor", async () => {
    // Given
    const manifest = Schema.decodeSync(PluginManifest)({
      name: "@example/commands",
      version: "1.0.0",
      api: 4,
      contributes: { commands: ["meta:example:hello"] },
    });
    const module = definePlugin({
      name: manifest.name,
      manifest,
      commands: new Map([
        [
          "meta:example:hello",
          async () => ({
            id: "meta:example:hello",
            summary: "Hello.",
            namespace: "meta" as const,
            bootstrap: "plugins" as const,
            resultSchema: Schema.Unknown,
            run: () => Effect.void,
          }),
        ],
      ]),
    });

    // When
    const candidates = pluginCommandCandidates([{ source: "explicit", manifest, entry: module, module }]);

    // Then
    expect(Either.isRight(candidates)).toBe(true);
    if (Either.isRight(candidates)) {
      expect(candidates.right.map(({ id }) => id)).toEqual(["meta:example:hello"]);
      expect((await candidates.right[0]?.load())?.id).toBe("meta:example:hello");
    }
  });

  test("accepts manifest-only command declarations without executable candidates", () => {
    // Given
    const manifest = Schema.decodeSync(PluginManifest)({
      name: "@example/manifest-only",
      version: "1.0.0",
      api: 4,
      contributes: { commands: ["example:doctor"] },
    });

    // When
    const candidates = pluginCommandCandidates([{ source: "user", manifest }]);

    // Then
    expect(Either.isRight(candidates)).toBe(true);
    if (Either.isRight(candidates)) expect(candidates.right).toEqual([]);
  });

  test("rejects executable command loaders absent from the manifest", () => {
    // Given
    const manifest = Schema.decodeSync(PluginManifest)({
      name: "@example/extra-loader",
      version: "1.0.0",
      api: 4,
      contributes: { commands: [] },
    });
    const module = definePlugin({
      name: manifest.name,
      manifest,
      commands: new Map([
        [
          "example:undeclared",
          async () => ({
            id: "example:undeclared",
            summary: "Undeclared.",
            namespace: "example" as const,
            bootstrap: "plugins" as const,
            resultSchema: Schema.Unknown,
            run: () => Effect.void,
          }),
        ],
      ]),
    });

    // When
    const candidates = pluginCommandCandidates([{ source: "explicit", manifest, entry: module, module }]);

    // Then
    expect(Either.isLeft(candidates)).toBe(true);
    if (Either.isLeft(candidates)) {
      expect(candidates.left.declared).toEqual([]);
      expect(candidates.left.provided).toEqual(["example:undeclared"]);
    }
  });
});
