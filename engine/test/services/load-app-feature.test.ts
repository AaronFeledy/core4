import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Layer, Schema } from "effect";

import { PluginLoadError } from "@lando/sdk/errors";
import { PluginRegistry } from "@lando/sdk/services";
import { makePluginRegistryLive } from "../../src/plugins/registry";
import { type LandoPluginModule, definePlugin } from "@lando/sdk/plugins";
import { PluginManifest } from "@lando/sdk/schema";
import { ConfigService } from "@lando/sdk/services";
import type { AppFeatureDefinition } from "@lando/sdk/services";

const runWithPluginRegistry = <A, E>(
  effect: Effect.Effect<A, E, PluginRegistry>,
  modules: ReadonlyArray<LandoPluginModule> = [],
) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(makePluginRegistryLive({ app: false, user: false }, modules))),
  );

const runExitWithPluginRegistry = <A, E>(
  effect: Effect.Effect<A, E, PluginRegistry>,
  modules: ReadonlyArray<LandoPluginModule> = [],
) =>
  Effect.runPromiseExit(
    effect.pipe(Effect.provide(makePluginRegistryLive({ app: false, user: false }, modules))),
  );

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
      selectors: { names: ["web"] },
      apply: () => Effect.void,
    };
    const extraBundledPlugin = definePlugin({
      name: "@example/app-features",
      manifest: Schema.decodeUnknownSync(PluginManifest)({
        name: "@example/app-features",
        version: "1.0.0",
        api: 4,
        entry: "index.js",
        contributes: { appFeatures: ["test.app-feature"] },
      }),
      appFeatures: new Map([["test.app-feature", feature]]),
    });

    const loaded = await runWithPluginRegistry(
      Effect.flatMap(PluginRegistry, (registry) => registry.loadAppFeature("test.app-feature")),
      [extraBundledPlugin],
    );

    expect(loaded).toBe(feature);
  });

  test("rejects an app feature that declares neither activatedBy nor selectors", async () => {
    const feature: AppFeatureDefinition = {
      id: "test.unscoped-app-feature",
      priority: 100,
      apply: () => Effect.void,
    };
    const extraBundledPlugin = definePlugin({
      name: "@example/unscoped-app-feature",
      manifest: Schema.decodeUnknownSync(PluginManifest)({
        name: "@example/unscoped-app-feature",
        version: "1.0.0",
        api: 4,
        entry: "index.js",
        contributes: { appFeatures: ["test.unscoped-app-feature"] },
      }),
      appFeatures: new Map([["test.unscoped-app-feature", feature]]),
    });

    const exit = await runExitWithPluginRegistry(
      Effect.flatMap(PluginRegistry, (registry) => registry.loadAppFeature("test.unscoped-app-feature")),
      [extraBundledPlugin],
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) throw new Error("expected failure");
    const failure = Cause.failureOption(exit.cause);
    expect(failure._tag).toBe("Some");
    if (failure._tag === "Some") expect(failure.value).toBeInstanceOf(PluginLoadError);
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
          "export const feature = { id: 'test.external-app-feature', priority: 100, selectors: { names: ['web'] }, apply: () => undefined };",
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
