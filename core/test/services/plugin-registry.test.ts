import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit } from "effect";

import { PluginLoadError } from "@lando/core/errors";
import { PluginRegistry } from "@lando/core/services";
import { PluginRegistryLive } from "../../src/plugins/registry.ts";

const EXPECTED_BUNDLED_PLUGIN_NAMES: ReadonlyArray<string> = [
  "@lando/provider-lando",
  "@lando/provider-docker",
  "@lando/service-lando",
  "@lando/logger-pretty",
];

const runWithPluginRegistry = <A, E>(effect: Effect.Effect<A, E, PluginRegistry>) =>
  Effect.runPromise(effect.pipe(Effect.provide(PluginRegistryLive)));

describe("PluginRegistryLive", () => {
  test("lists bundled plugin manifests", async () => {
    const manifests = await runWithPluginRegistry(
      Effect.flatMap(PluginRegistry, (registry) => registry.list),
    );

    expect(manifests.map((manifest) => String(manifest.name))).toEqual([...EXPECTED_BUNDLED_PLUGIN_NAMES]);
  });

  test("loads the provider-lando bundled manifest", async () => {
    const manifest = await runWithPluginRegistry(
      Effect.flatMap(PluginRegistry, (registry) => registry.load("@lando/provider-lando")),
    );

    expect(manifest).toMatchObject({
      name: "@lando/provider-lando",
      api: 4,
      bundled: true,
      contributes: { providers: ["lando"] },
    });
  });

  test("loads bundled service type contributions", async () => {
    const serviceType = await runWithPluginRegistry(
      Effect.flatMap(PluginRegistry, (registry) => registry.loadServiceType("node:lts")),
    );

    expect(serviceType.id).toBe("node:lts");
  });

  test("fails with PluginLoadError for plugins outside the bundled registry", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.flatMap(PluginRegistry, (registry) => registry.load("not-bundled")).pipe(
        Effect.provide(PluginRegistryLive),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect(failure.value).toBeInstanceOf(PluginLoadError);
        expect(failure.value.pluginName).toBe("not-bundled");
      }
    }
  });
});
