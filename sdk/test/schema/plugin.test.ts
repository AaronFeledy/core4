import { describe, expect, test } from "bun:test";

import { Either, Layer, Schema } from "effect";

import { definePlugin } from "@lando/sdk/plugins";
import { EmbeddingPluginPolicy, PluginManifest, getJsonSchema } from "@lando/sdk/schema";

describe("PluginManifest", () => {
  const notice = {
    since: "4.2.0",
    severity: "warn" as const,
    note: "Use the replacement surface.",
  };

  test("preserves whole-plugin deprecation notices when decoding", () => {
    const decoded = Schema.decodeUnknownSync(PluginManifest)({
      name: "@lando/legacy-plugin",
      version: "1.0.0",
      api: 4,
      deprecated: {
        since: "4.2.0",
        severity: "warn",
        note: "Use @lando/replacement-plugin.",
      },
    });

    expect(decoded.deprecated).toEqual({
      since: "4.2.0",
      severity: "warn",
      note: "Use @lando/replacement-plugin.",
    });
  });

  test("publishes deprecated in the PluginManifest JSON schema", () => {
    const jsonSchema = getJsonSchema("PluginManifest") as {
      readonly properties?: Record<string, unknown>;
    };

    expect(jsonSchema.properties).toHaveProperty("deprecated");
  });

  test("preserves deprecation notices on plugin contribution entries", () => {
    const decoded = Schema.decodeUnknownSync(PluginManifest)({
      name: "@lando/legacy-plugin",
      version: "1.0.0",
      api: 4,
      contributes: {
        commands: [{ id: "meta:legacy", deprecated: notice }],
        serviceTypes: [{ id: "legacy:php", deprecated: notice }],
        serviceFeatures: [{ id: "legacy-feature", deprecated: notice }],
        providers: [{ id: "legacy-provider", deprecated: notice }],
        proxies: [{ id: "legacy-proxy", deprecated: notice }],
        globalServices: [{ id: "legacy-global", deprecated: notice }],
        downloaders: [
          {
            id: "legacy-downloader",
            module: "./downloader.ts",
            capabilities: {
              schemes: ["https"],
              memoryDownload: true,
              cacheAware: true,
              offline: false,
              mirror: false,
            },
            enabledByDefault: true,
            summary: "Legacy downloader.",
            deprecated: notice,
          },
        ],
        httpClients: [
          {
            id: "legacy-http-client",
            module: "./http-client.ts",
            capabilities: {
              schemes: ["https"],
              streaming: true,
              upload: true,
              customCa: true,
              proxyAware: true,
            },
            enabledByDefault: true,
            summary: "Legacy HTTP client.",
            deprecated: notice,
          },
        ],
        setup: {
          flags: [{ name: "legacy-flag", type: "boolean", deprecated: notice }],
        },
      },
    });

    expect(decoded.contributes?.commands?.[0]).toEqual({ id: "meta:legacy", deprecated: notice });
    expect(decoded.contributes?.globalServices?.[0]).toMatchObject({
      id: "legacy-global",
      deprecated: notice,
    });
    expect(decoded.contributes?.downloaders?.[0]).toMatchObject({
      id: "legacy-downloader",
      deprecated: notice,
    });
    expect(decoded.contributes?.httpClients?.[0]).toMatchObject({
      id: "legacy-http-client",
      deprecated: notice,
    });
    expect(decoded.contributes?.setup?.flags?.[0]).toMatchObject({ name: "legacy-flag", deprecated: notice });
  });

  test("rejects invalid deprecation notices on nested plugin contribution entries", () => {
    const decoded = Schema.decodeUnknownEither(PluginManifest)(
      {
        name: "@lando/bad-plugin",
        version: "1.0.0",
        api: 4,
        contributes: {
          commands: [{ id: "meta:bad", deprecated: { since: "next", note: "bad" } }],
        },
      },
      { onExcessProperty: "error" },
    );

    expect(Either.isLeft(decoded)).toBe(true);
  });

  test("strict decoding rejects excess fields inside nested deprecation notices", () => {
    const decoded = Schema.decodeUnknownEither(PluginManifest)(
      {
        name: "@lando/bad-plugin",
        version: "1.0.0",
        api: 4,
        contributes: {
          commands: [
            {
              id: "meta:bad",
              deprecated: { since: "4.2.0", severity: "warn", note: "bad", extra: true },
            },
          ],
        },
      },
      { onExcessProperty: "error" },
    );

    expect(Either.isLeft(decoded)).toBe(true);
  });

  test("defaults an omitted plugin bootstrap declaration to app", () => {
    // Given: a plugin manifest with no explicit bootstrap declaration.
    const encoded = { name: "@lando/default-bootstrap", version: "1.0.0", api: 4 };

    // When: the public manifest schema decodes it.
    const decoded = Schema.decodeUnknownSync(PluginManifest)(encoded);

    // Then: subscriber validation receives the documented app-level default.
    expect(decoded).toHaveProperty("bootstrap", "app");
  });

  test("preserves every valid explicit plugin bootstrap declaration", () => {
    for (const bootstrap of [
      "none",
      "minimal",
      "plugins",
      "commands",
      "tooling",
      "provider",
      "global",
      "scratch",
      "app",
    ] as const) {
      // Given: a plugin manifest declaring one existing bootstrap level.
      const encoded = { name: `@lando/bootstrap-${bootstrap}`, version: "1.0.0", api: 4, bootstrap };

      // When: strict manifest decoding is applied.
      const decoded = Schema.decodeUnknownEither(PluginManifest)(encoded, { onExcessProperty: "error" });

      // Then: the declaration is accepted and preserved for closure validation.
      expect(Either.isRight(decoded), String(Either.getLeft(decoded))).toBe(true);
      if (Either.isRight(decoded)) expect(decoded.right).toHaveProperty("bootstrap", bootstrap);
    }
  });

  test("rejects an unknown plugin bootstrap declaration", () => {
    // Given: a plugin manifest declaring a level outside BootstrapLevel.
    const encoded = { name: "@lando/bootstrap-invalid", version: "1.0.0", api: 4, bootstrap: "fast" };

    // When: strict manifest decoding is applied.
    const decoded = Schema.decodeUnknownEither(PluginManifest)(encoded, { onExcessProperty: "error" });

    // Then: invalid declarations cannot reach subscriber registration.
    expect(Either.isLeft(decoded)).toBe(true);
  });

  test("decodes typed certificate authority contributions", () => {
    const encoded = {
      name: "@lando/ca-test",
      version: "1.0.0",
      api: 4,
      contributes: {
        certificateAuthorities: [
          {
            id: "test-ca",
            module: "./src/ca.ts",
            defaultFor: { platform: ["linux"] },
            enabledByDefault: true,
            summary: "Test certificate authority",
            deprecated: notice,
          },
        ],
      },
    };

    const decoded = Schema.decodeUnknownEither(PluginManifest)(encoded, { onExcessProperty: "error" });

    expect(Either.isRight(decoded), String(Either.getLeft(decoded))).toBe(true);
    if (Either.isRight(decoded)) {
      expect(decoded.right.contributes?.certificateAuthorities?.[0]).toEqual(
        encoded.contributes.certificateAuthorities[0],
      );
    }
  });

  test("strict decoding rejects the unreleased legacy cas contribution", () => {
    const decoded = Schema.decodeUnknownEither(PluginManifest)(
      {
        name: "@lando/legacy-ca",
        version: "1.0.0",
        api: 4,
        contributes: { cas: ["mkcert"] },
      },
      { onExcessProperty: "error" },
    );

    expect(Either.isLeft(decoded)).toBe(true);
  });

  test("strict decoding rejects the unreleased legacy proxyServices contribution", () => {
    const decoded = Schema.decodeUnknownEither(PluginManifest)(
      {
        name: "@lando/legacy-proxy",
        version: "1.0.0",
        api: 4,
        contributes: { proxyServices: [{ id: "traefik", module: "./src/proxy.ts" }] },
      },
      { onExcessProperty: "error" },
    );

    expect(Either.isLeft(decoded)).toBe(true);
  });

  test("decodes typed routerServices contributions", () => {
    const encoded = {
      name: "@lando/router-test",
      version: "1.0.0",
      api: 4,
      contributes: {
        routerServices: [{ id: "traefik", module: "./src/proxy.ts" }],
      },
    };

    const decoded = Schema.decodeUnknownEither(PluginManifest)(encoded, { onExcessProperty: "error" });

    expect(Either.isRight(decoded), String(Either.getLeft(decoded))).toBe(true);
    if (Either.isRight(decoded)) {
      expect(decoded.right.contributes?.routerServices?.[0]).toEqual(encoded.contributes.routerServices[0]);
    }
  });
});

describe("EmbeddingPluginPolicy", () => {
  test("accepts a pre-resolved manifest with an already-loaded plugin module entry", () => {
    const manifest = Schema.decodeSync(PluginManifest)({
      name: "@lando/embedded",
      version: "1.0.0",
      api: 4,
    });
    const entry = definePlugin({ name: manifest.name, manifest, layer: Layer.empty });

    const decoded = Schema.decodeUnknownEither(EmbeddingPluginPolicy)({ manifests: [{ manifest, entry }] });

    expect(Either.isRight(decoded), String(Either.getLeft(decoded))).toBe(true);
    if (Either.isRight(decoded) && typeof decoded.right !== "string") {
      expect(decoded.right.manifests?.[0]?.entry).toBe(entry);
    }
  });

  test("rejects malformed pre-resolved plugin entries", () => {
    const manifest = Schema.decodeSync(PluginManifest)({
      name: "@lando/embedded",
      version: "1.0.0",
      api: 4,
    });

    const decoded = Schema.decodeUnknownEither(EmbeddingPluginPolicy)({
      manifests: [{ manifest, entry: "./src/index.ts" }],
    });

    expect(Either.isLeft(decoded)).toBe(true);
  });
});
