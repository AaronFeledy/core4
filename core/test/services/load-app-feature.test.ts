import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Layer } from "effect";

import { PluginLoadError } from "@lando/core/errors";
import { PluginRegistry } from "@lando/core/services";
import type { AppFeatureDefinition } from "@lando/sdk/services";
import { BUNDLED_PLUGINS } from "../../src/plugins/bundled.ts";
import { makePluginRegistryLive } from "../../src/plugins/registry.ts";

const runWithPluginRegistry = <A, E>(effect: Effect.Effect<A, E, PluginRegistry>) =>
  Effect.runPromise(effect.pipe(Effect.provide(makePluginRegistryLive({ app: false, user: false }))));

const runExitWithPluginRegistry = <A, E>(effect: Effect.Effect<A, E, PluginRegistry>) =>
  Effect.runPromiseExit(effect.pipe(Effect.provide(makePluginRegistryLive({ app: false, user: false }))));

describe("PluginRegistry.loadAppFeature", () => {
  test("fails for an unknown bundled app feature", async () => {
    const exit = await runExitWithPluginRegistry(
      Effect.flatMap(PluginRegistry, (registry) => registry.loadAppFeature("does-not-exist")),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) throw new Error("expected failure");
    const failure = Cause.failureOption(exit.cause);
    expect(failure._tag).toBe("Some");
    if (failure._tag === "Some") expect(failure.value).toBeInstanceOf(PluginLoadError);
  });

  test("loads app feature contributions from bundled plugins", async () => {
    const feature: AppFeatureDefinition = {
      id: "test.app-feature",
      priority: 100,
      apply: () => Effect.void,
    };
    const extraBundledPlugin = {
      name: "@example/app-features",
      layer: Layer.empty,
      manifest: {
        name: "@example/app-features",
        version: "1.0.0",
        api: 4,
        entry: "index.js",
        contributes: { appFeatures: ["test.app-feature"] },
      },
      appFeatures: new Map([["test.app-feature", feature]]),
    } as (typeof BUNDLED_PLUGINS)[number];
    (BUNDLED_PLUGINS as Array<typeof extraBundledPlugin>).push(extraBundledPlugin);

    try {
      const loaded = await runWithPluginRegistry(
        Effect.flatMap(PluginRegistry, (registry) => registry.loadAppFeature("test.app-feature")),
      );

      expect(loaded).toBe(feature);
    } finally {
      (BUNDLED_PLUGINS as Array<typeof extraBundledPlugin>).pop();
    }
  });
});
