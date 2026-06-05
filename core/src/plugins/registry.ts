import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { type Context, Effect, Either, Layer, Schema } from "effect";

import { PluginLoadError, PluginManifestError } from "@lando/sdk/errors";
import { PluginManifest } from "@lando/sdk/schema";
import { ConfigService, Logger, PluginRegistry } from "@lando/sdk/services";

import { findAppRoot } from "../landofile/discovery.ts";
import { BUNDLED_PLUGINS } from "./bundled.ts";
import { readInstalledPluginRegistry } from "./installed-registry.ts";

type PluginSourceKind = "system" | "user" | "app";

interface DiscoveredPlugin {
  readonly source: PluginSourceKind;
  readonly manifest: PluginManifest;
}

const pluginManifestError = (message: string, cause: unknown): PluginManifestError =>
  new PluginManifestError({ message, issues: [String(cause)] });

const loadInstalledPluginManifest = async (packageRoot: string): Promise<PluginManifest> => {
  const packageJsonPath = join(packageRoot, "package.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(packageJsonPath, "utf8"));
  } catch (cause) {
    throw pluginManifestError(`Plugin package.json is invalid: ${packageJsonPath}`, cause);
  }
  const candidate = (parsed as { landoPlugin?: unknown }).landoPlugin ?? parsed;
  const decoded = Schema.decodeUnknownEither(PluginManifest)(candidate);
  if (Either.isLeft(decoded)) {
    throw pluginManifestError(`Plugin manifest validation failed: ${packageJsonPath}`, decoded.left);
  }
  return decoded.right;
};

const discoverInstalledPlugins = (
  source: Exclude<PluginSourceKind, "system">,
  pluginsRoot: string,
): Effect.Effect<ReadonlyArray<DiscoveredPlugin>, PluginManifestError> =>
  Effect.tryPromise({
    try: async () => {
      const registry = await readInstalledPluginRegistry(pluginsRoot);
      const plugins: Array<DiscoveredPlugin> = [];
      for (const entry of Object.values(registry)) {
        plugins.push({ source, manifest: await loadInstalledPluginManifest(entry.path) });
      }
      return plugins;
    },
    catch: (cause) =>
      cause instanceof PluginManifestError
        ? cause
        : pluginManifestError(`Failed to discover ${source} plugins from ${pluginsRoot}`, cause),
  });

const mergeDiscoveredPlugins = (
  sources: ReadonlyArray<ReadonlyArray<DiscoveredPlugin>>,
  logger: Context.Tag.Service<typeof Logger> | undefined,
): Effect.Effect<ReadonlyArray<PluginManifest>> =>
  Effect.gen(function* () {
    const merged = new Map<string, DiscoveredPlugin>();
    for (const source of sources) {
      for (const plugin of source) {
        const existing = merged.get(plugin.manifest.name);
        if (existing !== undefined && logger !== undefined) {
          yield* logger
            .warn(
              `Plugin ${plugin.manifest.name} from ${plugin.source} source overrides ${existing.source} source.`,
            )
            .pipe(Effect.catchAll(() => Effect.void));
        }
        merged.set(plugin.manifest.name, plugin);
      }
    }
    return [...merged.values()].map((plugin) => plugin.manifest);
  });

const systemPlugins: ReadonlyArray<DiscoveredPlugin> = BUNDLED_PLUGINS.map((plugin) => ({
  source: "system" as const,
  manifest: plugin.manifest,
}));

const makePluginRegistry = (
  configService: Context.Tag.Service<typeof ConfigService> | undefined,
  logger: Context.Tag.Service<typeof Logger> | undefined,
): Context.Tag.Service<typeof PluginRegistry> => {
  const discover = Effect.gen(function* () {
    if (configService === undefined) return systemPlugins.map((plugin) => plugin.manifest);
    const userDataRoot = yield* configService
      .get("userDataRoot")
      .pipe(Effect.catchAll(() => Effect.succeed(undefined)));
    if (userDataRoot === undefined) return systemPlugins.map((plugin) => plugin.manifest);
    const userPlugins = yield* discoverInstalledPlugins("user", join(userDataRoot, "plugins"));
    const appRoot = yield* Effect.promise(() => findAppRoot(process.cwd()));
    const appPlugins =
      appRoot === undefined ? [] : yield* discoverInstalledPlugins("app", join(appRoot, ".lando", "plugins"));
    return yield* mergeDiscoveredPlugins([systemPlugins, userPlugins, appPlugins], logger);
  });

  return {
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
    loadServiceType: (id) => {
      for (const bundledPlugin of BUNDLED_PLUGINS) {
        const serviceType = bundledPlugin.serviceTypes?.get(id);

        if (serviceType !== undefined) {
          return Effect.succeed(serviceType);
        }
      }

      return Effect.fail(
        new PluginLoadError({
          message: `Bundled service type ${id} is not registered.`,
          pluginName: "@lando/core",
        }),
      );
    },
  };
};

export { PluginRegistry };

export const PluginRegistryLive = Layer.effect(
  PluginRegistry,
  Effect.gen(function* () {
    const configService = yield* Effect.serviceOption(ConfigService);
    const logger = yield* Effect.serviceOption(Logger);
    return makePluginRegistry(
      configService._tag === "Some" ? configService.value : undefined,
      logger._tag === "Some" ? logger.value : undefined,
    );
  }),
);
