import { join } from "node:path";

import { Context, Effect, Either, Layer } from "effect";

import { PluginLoadError } from "@lando/sdk/errors";
import type { LandoPluginModule } from "@lando/sdk/plugins";
import { ConfigService, Logger, PluginRegistry } from "@lando/sdk/services";

import { makeLandoPaths } from "@lando/paths";
import { resolveUserDataRoot } from "../config/roots.ts";
import { findAppRoot } from "../landofile/discovery.ts";
import { composeExtendedServiceType } from "../services/extends.ts";
import { PluginContributionGraph } from "./contribution-graph.ts";
import { BUNDLED_PLUGIN_MODULES } from "./generated/bundled.ts";
import { GlobalPluginManifests } from "./global-manifests.ts";
import { type PluginCapabilityIndex, makePluginCapabilityIndex } from "./module-set.ts";
import {
  type DiscoveredPlugin,
  discoverInstalledPlugins,
  ensureScopedAppFeature,
  externalAppFeature,
  findExternalServiceType,
  mergeDiscoveredPlugins,
  systemPluginsFromModules,
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

interface PluginRegistryInput {
  readonly discovery: PluginRegistryDiscoveryOptions;
  readonly bundledPlugins: ReadonlyArray<DiscoveredPlugin>;
  readonly capabilities: PluginCapabilityIndex;
  readonly staticPlugins?: ReadonlyArray<DiscoveredPlugin>;
}

const makePluginRegistry = (
  configService: Context.Tag.Service<typeof ConfigService> | undefined,
  logger: Context.Tag.Service<typeof Logger> | undefined,
  input: PluginRegistryInput,
): PluginRegistryServices => {
  const { capabilities, discovery } = input;
  const disabled = new Set(discovery.disable ?? []);
  const staticPlugins = input.staticPlugins;
  const discoverGlobalPlugins = Effect.gen(function* () {
    if (staticPlugins !== undefined) return staticPlugins.filter((plugin) => plugin.source !== "app");
    const userDataRoot =
      configService === undefined
        ? resolveUserDataRoot()
        : yield* configService.get("userDataRoot").pipe(Effect.catchAll(() => Effect.succeed(undefined)));
    const userPlugins =
      discovery.user === false || userDataRoot === undefined
        ? []
        : yield* discoverInstalledPlugins("user", makeLandoPaths({ userDataRoot }).pluginsDir, logger);
    return yield* mergeDiscoveredPlugins([input.bundledPlugins, userPlugins], logger);
  });
  const discoverPlugins = Effect.gen(function* () {
    if (staticPlugins !== undefined) return staticPlugins;
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
        const bundledServiceType = capabilities.serviceTypes.get(id);
        if (bundledServiceType !== undefined) {
          return yield* composeExtendedServiceType(bundledServiceType, (parentId) =>
            capabilities.serviceTypes.get(parentId),
          );
        }

        const plugins = yield* discoverPlugins;
        const externalType = findExternalServiceType(plugins, id);
        if (externalType !== undefined) {
          return yield* composeExtendedServiceType(
            externalType,
            (parentId) =>
              findExternalServiceType(plugins, parentId) ?? capabilities.serviceTypes.get(parentId),
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

      const serviceFeature = capabilities.serviceFeatures.get(id);
      if (serviceFeature !== undefined) return Effect.succeed(serviceFeature);

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
          const appFeature = capabilities.appFeatures.get(id);
          if (appFeature !== undefined) return yield* ensureScopedAppFeature(appFeature);
        }

        const plugins = yield* discoverPlugins;
        for (const plugin of plugins) {
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

export const makePluginRegistryLive = (
  discovery: PluginRegistryDiscoveryOptions = {},
  modules: ReadonlyArray<LandoPluginModule> = BUNDLED_PLUGIN_MODULES,
) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const configService = yield* Effect.serviceOption(ConfigService);
      const logger = yield* Effect.serviceOption(Logger);
      const graph = yield* Effect.serviceOption(PluginContributionGraph);
      const staticPlugins = graph._tag === "Some" ? graph.value.plugins : undefined;
      const enabledModules =
        staticPlugins === undefined
          ? discovery.bundled === false
            ? []
            : modules.filter((module) => !(discovery.disable ?? []).includes(module.manifest.name))
          : staticPlugins.flatMap((plugin) =>
              plugin.source === "bundled" && plugin.entry !== undefined ? [plugin.entry] : [],
            );
      const capabilities = yield* Either.match(makePluginCapabilityIndex(enabledModules), {
        onLeft: (error) => Effect.fail(error),
        onRight: (index) => Effect.succeed(index),
      }).pipe(Effect.orDie);
      const services = makePluginRegistry(
        configService._tag === "Some" ? configService.value : undefined,
        logger._tag === "Some" ? logger.value : undefined,
        {
          discovery,
          bundledPlugins: systemPluginsFromModules(enabledModules),
          capabilities,
          ...(staticPlugins === undefined ? {} : { staticPlugins }),
        },
      );
      return Context.make(PluginRegistry, services.registry).pipe(
        Context.add(GlobalPluginManifests, services.globalManifests),
      );
    }),
  );

export const PluginRegistryLive = makePluginRegistryLive();
