import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Schema } from "effect";

import { PluginLoadError } from "@lando/sdk/errors";
import { PluginRegistry } from "@lando/sdk/services";
import { makePluginRegistryLive } from "../../src/plugins/registry";
import { type LandoPluginModule, definePlugin } from "@lando/sdk/plugins";
import { PluginManifest } from "@lando/sdk/schema";
import type { ServiceFeatureDefinition } from "@lando/sdk/services";

const runWithPluginRegistry = <A, E>(
  effect: Effect.Effect<A, E, PluginRegistry>,
  modules: ReadonlyArray<LandoPluginModule> = [],
) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(makePluginRegistryLive({ app: false, user: false }, modules))),
  );

const runExitWithPluginRegistry = <A, E>(effect: Effect.Effect<A, E, PluginRegistry>) =>
  Effect.runPromiseExit(effect.pipe(Effect.provide(makePluginRegistryLive({ app: false, user: false }, []))));

describe("PluginRegistry.loadServiceFeature", () => {
  test("fails for an unknown bundled service feature", async () => {
    const exit = await runExitWithPluginRegistry(
      Effect.flatMap(PluginRegistry, (registry) => registry.loadServiceFeature("does-not-exist")),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) throw new Error("expected failure");
    const failure = Cause.failureOption(exit.cause);
    expect(failure._tag).toBe("Some");
    if (failure._tag === "Some") expect(failure.value).toBeInstanceOf(PluginLoadError);
  });

  test("loads service feature contributions from bundled plugins", async () => {
    const feature: ServiceFeatureDefinition = {
      id: "test.feat",
      priority: 100,
      apply: () => Effect.void,
    };
    const extraBundledPlugin = definePlugin({
      name: "@example/service-features",
      manifest: Schema.decodeUnknownSync(PluginManifest)({
        name: "@example/service-features",
        version: "1.0.0",
        api: 4,
        entry: "index.js",
        contributes: { serviceFeatures: ["test.feat"] },
      }),
      serviceFeatures: new Map([["test.feat", feature]]),
    });

    const loaded = await runWithPluginRegistry(
      Effect.flatMap(PluginRegistry, (registry) => registry.loadServiceFeature("test.feat")),
      [extraBundledPlugin],
    );

    expect(loaded).toBe(feature);
  });
});
