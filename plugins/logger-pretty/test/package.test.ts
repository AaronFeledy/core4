import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";

import { runPluginContract } from "@lando/sdk/test";

describe("@lando/logger-pretty package", () => {
  test("exports the package skeleton", async () => {
    const plugin = await import("@lando/logger-pretty");

    expect(plugin.PLUGIN_NAME).toBe("@lando/logger-pretty");
    expect(Layer.isLayer(plugin.logger)).toBe(true);
    expect(plugin.logger).toBe(Layer.empty);
    expect(plugin.manifest).toMatchObject({
      name: "@lando/logger-pretty",
      version: "0.0.0",
      api: 4,
      contributes: { loggers: ["pretty"] },
    });
  });

  test("satisfies the published plugin contract suite", async () => {
    const plugin = await import("@lando/logger-pretty");

    await expect(
      Effect.runPromise(
        runPluginContract({
          manifest: plugin.manifest,
          layers: { logger: plugin.logger },
        }),
      ),
    ).resolves.toBeUndefined();
  });
});
