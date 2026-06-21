import { Either, Schema } from "effect";

import { PluginManifest, getJsonSchema } from "@lando/sdk/schema";

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
});
