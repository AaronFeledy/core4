import { join } from "node:path";

import { Context, Effect, Layer } from "effect";

import { PluginLoadError } from "@lando/sdk/errors";
import { ConfigService, Logger, PluginRegistry } from "@lando/sdk/services";

import { makeLandoPaths } from "../config/paths.ts";
import { resolveUserDataRoot } from "../config/roots.ts";
import { findAppRoot } from "../landofile/discovery.ts";
import { composeExtendedServiceType } from "../services/extends.ts";
import { BUNDLED_PLUGINS } from "./bundled.ts";
import { GlobalPluginManifests } from "./global-manifests.ts";
import {
  discoverInstalledPlugins,
  ensureScopedAppFeature,
  externalAppFeature,
  findBundledServiceType,
  findExternalServiceType,
  mergeDiscoveredPlugins,
  systemPlugins,
} from "./plugin-discovery.ts";

interface PluginRegistryDiscoveryOptions {
  readonly bundled?: boolean;
  readonly user?: boolean;
  readonly app?: boolean;
  readonly disable?: ReadonlyArray<string>;
}

interface PluginRegistryServices {
  readonly registry: Context.Tag.Service<typeof PluginRegistry>;
  readonly globalManifests: Context.Tag.Service<typeof GlobalPluginManifests>;
}

const makePluginRegistry = (
  configService: Context.Tag.Service<typeof ConfigService> | undefined,
  logger: Context.Tag.Service<typeof Logger> | undefined,
  discovery: PluginRegistryDiscoveryOptions,
): PluginRegistryServices => {
  const disabled = new Set(discovery.disable ?? []);
  const discoverGlobalPlugins = Effect.gen(function* () {
    const bundledPlugins = (discovery.bundled === false ? [] : systemPlugins).filter(
      (plugin) => !disabled.has(plugin.manifest.name),
    );
    const userDataRoot =
      configService === undefined
        ? resolveUserDataRoot()
        : yield* configService.get("userDataRoot").pipe(Effect.catchAll(() => Effect.succeed(undefined)));
    const userPlugins =
      discovery.user === false || userDataRoot === undefined
        ? []
        : yield* discoverInstalledPlugins("user", makeLandoPaths({ userDataRoot }).pluginsDir, logger);
    return yield* mergeDiscoveredPlugins([bundledPlugins, userPlugins], logger);
  });
  const discoverPlugins = Effect.gen(function* () {
    const globalPlugins = yield* discoverGlobalPlugins;
    const appRoot =
      discovery.app === false ? undefined : yield* Effect.promise(() => findAppRoot(process.cwd()));
    const appPlugins =
      appRoot === undefined
        ? []
        : yield* discoverInstalledPlugins("app", join(appRoot, ".lando", "plugins"), logger);
    const manifests = yield* mergeDiscoveredPlugins([globalPlugins, appPlugins], logger);
    return manifests.filter((plugin) => !disabled.has(plugin.manifest.name));
  });
  const discover = discoverPlugins.pipe(Effect.map((plugins) => plugins.map((plugin) => plugin.manifest)));
  const discoverGlobal = discoverGlobalPlugins.pipe(
    Effect.map((plugins) =>
      plugins.filter((plugin) => !disabled.has(plugin.manifest.name)).map((plugin) => plugin.manifest),
    ),
  );

  const registry: Context.Tag.Service<typeof PluginRegistry> = {
    list: discover,
    load: (name) =>
      Effect.gen(function* () {
        const manifests = yield* discover;
        const manifest = manifests.find((plugin) => plugin.name === name);

        if (manifest !== undefined) {
          return manifest;
        }

        return yield* Effect.fail(
          new PluginLoadError({
            message: `Plugin ${name} is not registered.`,
            pluginName: name,
          }),
        );
      }),
    loadServiceType: (id) =>
      Effect.gen(function* () {
        const bundledServiceType =
          discovery.bundled === false ? undefined : findBundledServiceType(id, disabled);
        if (bundledServiceType !== undefined) {
          return yield* composeExtendedServiceType(bundledServiceType, (parentId) =>
            findBundledServiceType(parentId, disabled),
          );
        }

        const plugins = yield* discoverPlugins;
        const externalType = findExternalServiceType(plugins, id);
        if (externalType !== undefined) {
          return yield* composeExtendedServiceType(
            externalType,
            (parentId) =>
              findExternalServiceType(plugins, parentId) ??
              (discovery.bundled === false ? undefined : findBundledServiceType(parentId, disabled)),
          );
        }

        return yield* Effect.fail(
          new PluginLoadError({
            message: `Service type ${id} is not registered.`,
            pluginName: "@lando/core",
          }),
        );
      }),
    loadServiceFeature: (id) => {
      if (discovery.bundled === false) {
        return Effect.fail(
          new PluginLoadError({
            message: `Bundled service feature ${id} is not registered.`,
            pluginName: "@lando/core",
          }),
        );
      }

      for (const bundledPlugin of BUNDLED_PLUGINS) {
        if (disabled.has(bundledPlugin.manifest.name)) continue;
        const serviceFeature = bundledPlugin.serviceFeatures?.get(id);

        if (serviceFeature !== undefined) {
          return Effect.succeed(serviceFeature);
        }
      }

      return Effect.fail(
        new PluginLoadError({
          message: `Bundled service feature ${id} is not registered.`,
          pluginName: "@lando/core",
        }),
      );
    },
    loadAppFeature: (id) =>
      Effect.gen(function* () {
        if (discovery.bundled !== false) {
          for (const bundledPlugin of BUNDLED_PLUGINS) {
            if (disabled.has(bundledPlugin.manifest.name)) continue;
            const appFeature = bundledPlugin.appFeatures?.get(id);

            if (appFeature !== undefined) return yield* ensureScopedAppFeature(appFeature);
          }
        }

        const plugins = yield* discoverPlugins;
        for (const plugin of plugins) {
          if (plugin.source === "system") continue;
          const appFeature = externalAppFeature(plugin, id);
          if (appFeature !== undefined) return yield* ensureScopedAppFeature(appFeature);
        }

        return yield* Effect.fail(
          new PluginLoadError({
            message: `App feature ${id} is not registered.`,
            pluginName: "@lando/core",
          }),
        );
      }),
  };
  return { registry, globalManifests: { list: discoverGlobal } };
};

export { PluginRegistry };

export const makePluginRegistryLive = (discovery: PluginRegistryDiscoveryOptions = {}) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const configService = yield* Effect.serviceOption(ConfigService);
      const logger = yield* Effect.serviceOption(Logger);
      const services = makePluginRegistry(
        configService._tag === "Some" ? configService.value : undefined,
        logger._tag === "Some" ? logger.value : undefined,
        discovery,
      );
      return Context.make(PluginRegistry, services.registry).pipe(
        Context.add(GlobalPluginManifests, services.globalManifests),
      );
    }),
  );

export const PluginRegistryLive = makePluginRegistryLive();
