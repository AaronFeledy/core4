import { describe, expect, test } from "bun:test";

import { Schema } from "effect";

import { type LandoPluginModule, definePlugin } from "@lando/sdk/plugins";
import { PluginManifest, ProviderId } from "@lando/sdk/schema";

const manifest = Schema.decodeSync(PluginManifest)({
  name: "@lando/test-plugin-module",
  version: "0.0.0",
  api: 4,
  requires: { "@lando/core": "^4.0.0" },
  contributes: { providers: ["manifest-provider"] },
  entry: "./src/index.ts",
});

describe("definePlugin", () => {
  test("returns the same descriptor when given a minimal plugin module", () => {
    // Given
    const descriptor: LandoPluginModule = { name: manifest.name, manifest };

    // When
    const defined = definePlugin(descriptor);

    // Then
    expect(defined).toBe(descriptor);
  });

  test("keeps manifest provider declarations inspectable beside runtime provider keys", () => {
    // Given
    const descriptor = definePlugin({
      name: manifest.name,
      manifest,
      runtimeProviders: new Map(),
    });

    // When
    const manifestProviderIds = (descriptor.manifest.contributes?.providers ?? []).map((entry) =>
      typeof entry === "string" ? entry : entry.id,
    );
    const runtimeProviderIds = [...(descriptor.runtimeProviders?.keys() ?? [])];
    const missingProviderIds = manifestProviderIds.filter(
      (id) => !runtimeProviderIds.includes(Schema.decodeSync(ProviderId)(id)),
    );

    // Then
    expect(missingProviderIds).toEqual(["manifest-provider"]);
  });
});
