import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Layer } from "effect";

import { PluginLoadError } from "@lando/core/errors";
import { PluginRegistry } from "@lando/core/services";
import { ConfigService } from "@lando/sdk/services";
import type { AppFeatureDefinition } from "@lando/sdk/services";
import { BUNDLED_PLUGINS } from "../../src/plugins/bundled.ts";
import { makePluginRegistryLive } from "../../src/plugins/registry.ts";

const runWithPluginRegistry = <A, E>(effect: Effect.Effect<A, E, PluginRegistry>) =>
  Effect.runPromise(effect.pipe(Effect.provide(makePluginRegistryLive({ app: false, user: false }))));

const runExitWithPluginRegistry = <A, E>(effect: Effect.Effect<A, E, PluginRegistry>) =>
  Effect.runPromiseExit(effect.pipe(Effect.provide(makePluginRegistryLive({ app: false, user: false }))));

const configServiceFor = (userDataRoot: string) =>
  Layer.succeed(ConfigService, {
    get: <K extends string>(key: K) =>
      Effect.succeed(key === "userDataRoot" ? (userDataRoot as never) : (undefined as never)),
    getEffective: () => Effect.succeed({} as never),
  } as never);

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

  test("loads app feature contributions from linked user plugins", async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-load-app-feature-"));
    try {
      const userDataRoot = join(root, "data");
      const pluginRoot = join(root, "plugin");
      const registryEntry = join(userDataRoot, "plugins", "lando-plugin-app-feature");
      await mkdir(pluginRoot, { recursive: true });
      await mkdir(join(userDataRoot, "plugins"), { recursive: true });
      await writeFile(
        join(pluginRoot, "package.json"),
        `${JSON.stringify(
          {
            name: "lando-plugin-app-feature",
            version: "1.0.0",
            type: "module",
            landoPlugin: {
              name: "lando-plugin-app-feature",
              version: "1.0.0",
              api: 4,
              entry: "index.js",
              contributes: { appFeatures: ["test.external-app-feature"] },
            },
          },
          null,
          2,
        )}\n`,
      );
      await writeFile(
        join(pluginRoot, "index.js"),
        [
          "export const feature = { id: 'test.external-app-feature', priority: 100, apply: () => undefined };",
          "export const appFeatures = new Map([[feature.id, feature]]);",
          "",
        ].join("\n"),
      );
      await writeFile(
        join(userDataRoot, "plugins", "registry.json"),
        `${JSON.stringify(
          {
            "lando-plugin-app-feature": {
              name: "lando-plugin-app-feature",
              version: "1.0.0",
              path: registryEntry,
              source: "linked",
              linkedPath: pluginRoot,
            },
          },
          null,
          2,
        )}\n`,
      );
      await Bun.$`ln -s ${pluginRoot} ${registryEntry}`;

      const registryLayer = makePluginRegistryLive({ app: false, bundled: false }).pipe(
        Layer.provide(configServiceFor(userDataRoot)),
      );

      const loaded = await Effect.runPromise(
        Effect.flatMap(PluginRegistry, (registry) =>
          registry.loadAppFeature("test.external-app-feature"),
        ).pipe(Effect.provide(registryLayer)),
      );

      expect(loaded.id).toBe("test.external-app-feature");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
