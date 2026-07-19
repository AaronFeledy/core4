import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";
import { Context, Effect, Layer } from "effect";

import * as fileSyncMutagen from "@lando/file-sync-mutagen";
import * as loggerPretty from "@lando/logger-pretty";
import * as notifyLando from "@lando/notify-lando";
import * as providerDocker from "@lando/provider-docker";
import * as providerLando from "@lando/provider-lando";
import * as providerPodman from "@lando/provider-podman";
import * as proxyTraefik from "@lando/proxy-traefik";
import * as rendererLando from "@lando/renderer-lando";
import * as serviceLando from "@lando/service-lando";
import * as templateHandlebars from "@lando/template-handlebars";
import * as templateMustache from "@lando/template-mustache";

import { ConfigService, Logger } from "@lando/sdk/services";

import { BUNDLED_PLUGINS } from "../../src/plugins/bundled.ts";
import { PluginRegistry, PluginRegistryLive } from "../../src/plugins/registry.ts";

const EXPECTED_BUNDLED_PLUGINS = [
  { name: "@lando/provider-lando", layer: providerLando.provider, manifest: providerLando.manifest },
  { name: "@lando/provider-docker", layer: providerDocker.provider, manifest: providerDocker.manifest },
  { name: "@lando/provider-podman", layer: providerPodman.provider, manifest: providerPodman.manifest },
  { name: "@lando/service-lando", layer: serviceLando.services, manifest: serviceLando.manifest },
  { name: "@lando/logger-pretty", layer: loggerPretty.logger, manifest: loggerPretty.manifest },
  { name: "@lando/renderer-lando", layer: Layer.empty, manifest: rendererLando.manifest },
  { name: "@lando/notify-lando", layer: Layer.empty, manifest: notifyLando.manifest },
  {
    name: "@lando/file-sync-mutagen",
    layer: fileSyncMutagen.engine,
    manifest: fileSyncMutagen.manifest,
  },
  { name: "@lando/proxy-traefik", layer: proxyTraefik.proxy, manifest: proxyTraefik.manifest },
  {
    name: "@lando/template-handlebars",
    layer: templateHandlebars.templateEngine,
    manifest: templateHandlebars.manifest,
  },
  {
    name: "@lando/template-mustache",
    layer: templateMustache.templateEngine,
    manifest: templateMustache.manifest,
  },
];

const bundledModulePath = resolve(import.meta.dirname, "../../src/plugins/bundled.ts");
const generatorPath = resolve(import.meta.dirname, "../../../scripts/build-bundled-plugins.ts");
const notifyIndexPath = resolve(import.meta.dirname, "../../../plugins/notify-lando/src/index.ts");

describe("BUNDLED_PLUGINS", () => {
  test("exports all bundled plugins with real layer and manifest references", async () => {
    expect(BUNDLED_PLUGINS).toHaveLength(11);
    expect(BUNDLED_PLUGINS.map((plugin) => plugin.name)).toEqual(
      EXPECTED_BUNDLED_PLUGINS.map((plugin) => plugin.name),
    );

    for (const [index, expected] of EXPECTED_BUNDLED_PLUGINS.entries()) {
      const plugin = BUNDLED_PLUGINS[index];

      if (plugin === undefined) {
        throw new Error(`Missing bundled plugin at index ${index}.`);
      }

      expect(Layer.isLayer(plugin.layer)).toBe(true);
      expect(plugin.layer).toBe(expected.layer);
      expect(plugin.manifest).toBe(expected.manifest);
    }

    const serviceLandoEntry = BUNDLED_PLUGINS.find((plugin) => plugin.name === "@lando/service-lando");
    expect(serviceLandoEntry?.globalServices?.get("mailpit")).toBe(
      serviceLando.globalServices.get("mailpit"),
    );

    const handlebarsEntry = BUNDLED_PLUGINS.find((plugin) => plugin.name === "@lando/template-handlebars");
    expect(handlebarsEntry?.templateEngines?.get("handlebars")).toBe(
      templateHandlebars.templateEngines.get("handlebars"),
    );
    const mustacheEntry = BUNDLED_PLUGINS.find((plugin) => plugin.name === "@lando/template-mustache");
    expect(mustacheEntry?.templateEngines?.get("mustache")).toBe(
      templateMustache.templateEngines.get("mustache"),
    );
    const notifyEntry = BUNDLED_PLUGINS.find((plugin) => plugin.name === "@lando/notify-lando");
    const notifyFactory = await notifyEntry?.subscriberFactoryLoaders?.get("notify-command-terminal")?.();
    expect(typeof notifyFactory).toBe("function");
  });

  test("every bundled plugin manifest declares the @lando/core compatibility range", () => {
    for (const expected of EXPECTED_BUNDLED_PLUGINS) {
      expect(expected.manifest.requires?.["@lando/core"]).toBe("^4.0.0");
    }
  });

  test("every bundled plugin manifest receives the omitted app bootstrap default", () => {
    // Given: bundled manifests remain unchanged and omit bootstrap declarations.
    const manifests = EXPECTED_BUNDLED_PLUGINS.map((plugin) => plugin.manifest);

    // When: their decoded bootstrap levels are inspected.
    const bootstrapLevels = manifests.map(
      (manifest) => Object.getOwnPropertyDescriptor(manifest, "bootstrap")?.value,
    );

    // Then: all bundled plugins retain app-level subscriber coverage by default.
    expect(bootstrapLevels).toEqual(manifests.map(() => "app"));
  });

  test("generated bundled plugin module is idempotent", async () => {
    const before = await readFile(bundledModulePath, "utf8");
    const proc = Bun.spawnSync([process.execPath, generatorPath], {
      cwd: resolve(import.meta.dirname, "../../.."),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).toBe(0);
    const after = await readFile(bundledModulePath, "utf8");

    expect(after).toBe(before);
  });

  test("bundled subscriber module remains lazy behind a Bun-traceable literal importer", async () => {
    // Given: the package index and generated compiled-bundle table.
    const [indexSource, bundledSource] = await Promise.all([
      readFile(notifyIndexPath, "utf8"),
      readFile(bundledModulePath, "utf8"),
    ]);

    // When: their subscriber loading edges are inspected.
    const importsPolicyAtIndex = indexSource.includes('from "./notify.ts"');
    const hasLiteralLazyImport = bundledSource.includes('import("@lando/notify-lando/notify")');

    // Then: manifest loading is side-effect free and Bun can trace the lazy policy module.
    expect(importsPolicyAtIndex).toBe(false);
    expect(hasLiteralLazyImport).toBe(true);
  });

  test("PluginRegistryLive lists and loads bundled manifests when external registries are empty", async () => {
    const userDataRoot = await mkdtemp(resolve(tmpdir(), "lando-bundled-registry-"));
    try {
      const registryLayer = PluginRegistryLive.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ConfigService, {
              load: Effect.succeed({ userDataRoot } as never),
              get: (key) =>
                Effect.succeed(key === "userDataRoot" ? (userDataRoot as never) : (undefined as never)),
            }),
            Layer.succeed(Logger, {
              debug: () => Effect.void,
              info: () => Effect.void,
              warn: () => Effect.void,
              error: () => Effect.void,
            }),
          ),
        ),
      );
      const context = await Effect.runPromise(Effect.scoped(Layer.build(registryLayer)));
      const registry = Context.get(context, PluginRegistry);
      const manifests = await Effect.runPromise(registry.list);
      const manifestNames: ReadonlyArray<string> = manifests.map((manifest) => String(manifest.name));
      expect(manifestNames).toEqual(EXPECTED_BUNDLED_PLUGINS.map((plugin) => plugin.name));

      const manifest = await Effect.runPromise(registry.load("@lando/provider-docker"));
      const loadedName: string = String(manifest.name);
      expect(loadedName).toBe("@lando/provider-docker");

      const exit = await Effect.runPromiseExit(registry.load("@lando/not-bundled"));
      expect(exit._tag).toBe("Failure");
    } finally {
      await rm(userDataRoot, { recursive: true, force: true });
    }
  });
});
