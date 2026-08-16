import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";

import { stripHostProxyRunLando } from "@lando/core/testing";
import { runPluginContract } from "@lando/sdk/test";

describe("@lando/provider-lando package", () => {
  test("exports the package skeleton", async () => {
    const plugin = await import("@lando/provider-lando");

    expect(plugin.PLUGIN_NAME).toBe("@lando/provider-lando");
    expect(plugin.makeWslMountPropagationCheck).toBeFunction();
    expect(plugin.parseRootMountPropagation).toBeFunction();
    expect(
      Layer.isLayer(
        plugin.makeProviderLayer({ sanitizeAppliedPlan: stripHostProxyRunLando, platform: "linux" }),
      ),
    ).toBe(true);
    expect(plugin.manifest).toMatchObject({
      name: "@lando/provider-lando",
      version: "0.0.0",
      api: 4,
      contributes: { providers: ["lando"] },
    });
  });

  test("satisfies the published plugin contract suite", async () => {
    const plugin = await import("@lando/provider-lando");

    await expect(
      Effect.runPromise(
        runPluginContract({
          manifest: plugin.manifest,
          layers: {
            provider: plugin.makeProviderLayer({
              sanitizeAppliedPlan: stripHostProxyRunLando,
              platform: "linux",
            }),
          },
        }),
      ),
    ).resolves.toBeUndefined();
  });
});
