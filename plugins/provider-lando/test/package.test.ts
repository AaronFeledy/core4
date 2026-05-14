import { describe, expect, test } from "bun:test";
import { Layer } from "effect";

describe("@lando/provider-lando package", () => {
  test("exports the package skeleton", async () => {
    const plugin = await import("@lando/provider-lando");

    expect(plugin.PLUGIN_NAME).toBe("@lando/provider-lando");
    expect(Layer.isLayer(plugin.provider)).toBe(true);
    expect(plugin.manifest).toMatchObject({
      name: "@lando/provider-lando",
      version: "0.0.0",
      api: 4,
      contributes: { providers: ["lando"] },
    });
  });
});
