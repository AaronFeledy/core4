import { describe, expect, test } from "bun:test";
import { Context, Effect, Layer, Schema } from "effect";

import { ConfigTranslatorConflictError, PluginLoadError } from "@lando/sdk/errors";
import type { LandoPluginModule } from "@lando/sdk/plugins";
import { PluginManifest } from "@lando/sdk/schema";
import { ConfigTranslatorRegistry, type ConfigTranslatorShape } from "@lando/sdk/services";

import { PluginContributionGraph } from "../../src/plugins/contribution-graph.ts";
import { makeConfigTranslatorRegistryLive } from "../../src/plugins/config-translator-registry.ts";

const fakeTranslator = (id: string): ConfigTranslatorShape => ({
  id,
  summary: `${id} translator`,
  inputKinds: [id],
  detect: () => Effect.succeed([]),
  translate: () => Effect.die(new Error("not exercised")),
});

const makeModule = (
  name: string,
  translators: ReadonlyArray<{ readonly id: string; readonly loads?: string }>,
  calls: Array<string>,
): LandoPluginModule => ({
  name,
  manifest: Schema.decodeSync(PluginManifest)({
    name,
    version: "1.0.0",
    api: 4,
    contributes: {
      configTranslators: translators.map(({ id }) => ({ id, module: "./translator.ts", inputKinds: [id] })),
    },
  }),
  configTranslators: new Map(
    translators.map(({ id, loads }) => [
      id,
      async () => {
        calls.push(`${name}:${id}`);
        return fakeTranslator(loads ?? id);
      },
    ]),
  ),
});

const graphLayer = (plugins: ReadonlyArray<{ readonly source: "bundled" | "user" | "explicit"; readonly entry: LandoPluginModule }>) =>
  Layer.succeed(PluginContributionGraph, {
    plugins: plugins.map(({ source, entry }) => ({ source, manifest: entry.manifest, entry, module: entry })),
    certificateAuthorities: [],
    commands: [],
    hostContext: Context.empty(),
  });

const listWith = (registryLayer: Layer.Layer<ConfigTranslatorRegistry, never, never>) =>
  Effect.runPromiseExit(
    Effect.gen(function* () {
      const registry = yield* ConfigTranslatorRegistry;
      return yield* registry.list;
    }).pipe(Effect.provide(registryLayer)),
  );

describe("ConfigTranslatorRegistry", () => {
  test("lists translators from every graph source in order and loads each factory once", async () => {
    // Given: a bundled module and a host-injected module each contributing a translator.
    const calls: Array<string> = [];
    const bundled = makeModule("@lando/bundled", [{ id: "lando4" }], calls);
    const injected = makeModule("@acme/host", [{ id: "terraform" }], calls);
    const registryLayer = makeConfigTranslatorRegistryLive([]).pipe(
      Layer.provide(
        graphLayer([
          { source: "bundled", entry: bundled },
          { source: "explicit", entry: injected },
        ]),
      ),
    );

    // When: the layer is built without listing.
    const built = await Effect.runPromise(Effect.scoped(Layer.build(registryLayer)));
    expect(calls).toEqual([]);

    // And: the registry lists twice.
    const registry = Context.get(built, ConfigTranslatorRegistry);
    const first = await Effect.runPromise(registry.list);
    const second = await Effect.runPromise(registry.list);

    // Then: both translators appear in graph order and each loader ran once.
    expect(first.map((translator) => translator.id)).toEqual(["lando4", "terraform"]);
    expect(second).toBe(first);
    expect(calls).toEqual(["@lando/bundled:lando4", "@acme/host:terraform"]);
  });

  test("falls back to the supplied modules when no contribution graph is provided", async () => {
    // Given: a registry built from explicit modules only.
    const calls: Array<string> = [];
    const module = makeModule("@lando/bundled", [{ id: "lando4" }], calls);

    // When: the registry lists.
    const exit = await listWith(makeConfigTranslatorRegistryLive([module]));

    // Then: the bundled translator resolves.
    expect(exit._tag).toBe("Success");
    if (exit._tag === "Success") expect(exit.value.map((translator) => translator.id)).toEqual(["lando4"]);
  });

  test("fails duplicate ids across sources naming both producers before loading anything", async () => {
    // Given: a bundled and a user plugin both contributing `lando3`.
    const calls: Array<string> = [];
    const bundled = makeModule("@lando/lando3", [{ id: "lando3" }], calls);
    const user = makeModule("@acme/lando3-fork", [{ id: "lando3" }], calls);
    const registryLayer = makeConfigTranslatorRegistryLive([]).pipe(
      Layer.provide(
        graphLayer([
          { source: "bundled", entry: bundled },
          { source: "user", entry: user },
        ]),
      ),
    );

    // When: the registry lists.
    const exit = await listWith(registryLayer);

    // Then: the collision is tagged, names both plugins, and no loader ran.
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const error = exit.cause._tag === "Fail" ? exit.cause.error : undefined;
      expect(error).toBeInstanceOf(ConfigTranslatorConflictError);
      if (error instanceof ConfigTranslatorConflictError) {
        expect(error.id).toBe("lando3");
        expect(error.translators).toEqual(["@lando/lando3", "@acme/lando3-fork"]);
      }
    }
    expect(calls).toEqual([]);
  });

  test("fails when a loaded translator reports a different id than its contribution", async () => {
    // Given: a module whose loader returns a translator with a foreign id.
    const calls: Array<string> = [];
    const module = makeModule("@lando/bundled", [{ id: "lando4", loads: "other" }], calls);

    // When: the registry lists.
    const exit = await listWith(makeConfigTranslatorRegistryLive([module]));

    // Then: the mismatch is a plugin load error attributed to the producer.
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const error = exit.cause._tag === "Fail" ? exit.cause.error : undefined;
      expect(error).toBeInstanceOf(PluginLoadError);
      if (error instanceof PluginLoadError) expect(error.pluginName).toBe("@lando/bundled");
    }
  });
});
