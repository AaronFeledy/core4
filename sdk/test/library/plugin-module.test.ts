import { describe, expect, test } from "bun:test";

import { Effect, Layer, Schema } from "effect";

import { type LandoPluginModule, definePlugin } from "@lando/sdk/plugins";
import { PluginManifest, ProviderId } from "@lando/sdk/schema";
import { CertificateAuthority } from "@lando/sdk/services";

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

  test("keeps typed certificate authority layers keyed by manifest id", () => {
    const caManifest = Schema.decodeSync(PluginManifest)({
      name: "@lando/test-ca-module",
      version: "1.0.0",
      api: 4,
      contributes: {
        certificateAuthorities: [{ id: "test-ca", module: "./src/ca.ts" }],
      },
    });
    const caLayer = Layer.succeed(CertificateAuthority, {
      id: "test-ca",
      setup: () => Effect.void,
      issueCert: () => Effect.die("not exercised"),
    });

    const descriptor = definePlugin({
      name: caManifest.name,
      manifest: caManifest,
      certificateAuthorities: new Map([["test-ca", caLayer]]),
    });

    expect(descriptor.certificateAuthorities?.get("test-ca")).toBe(caLayer);
  });
});
