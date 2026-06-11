import { Schema } from "effect";

import { PluginManifest, getJsonSchema } from "@lando/sdk/schema";

describe("PluginManifest", () => {
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
});
