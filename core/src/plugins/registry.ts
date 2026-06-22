import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { type Context, Effect, Either, Layer, Schema } from "effect";

import { PluginLoadError, PluginManifestError } from "@lando/sdk/errors";
import { PluginManifest } from "@lando/sdk/schema";
import { ConfigService, Logger, PluginRegistry } from "@lando/sdk/services";

import { findAppRoot } from "../landofile/discovery.ts";
import { BUNDLED_PLUGINS } from "./bundled.ts";
import { readInstalledPluginRegistry } from "./installed-registry.ts";

type PluginSourceKind = "system" | "user" | "app";

interface PluginRegistryDiscoveryOptions {
  readonly bundled?: boolean;
  readonly user?: boolean;
  readonly app?: boolean;
  readonly disable?: ReadonlyArray<string>;
}

interface DiscoveredPlugin {
  readonly source: PluginSourceKind;
  readonly manifest: PluginManifest;
}

const pluginManifestError = (message: string, cause: unknown): PluginManifestError =>
  new PluginManifestError({ message, issues: [String(cause)] });

const pluginLoadError = (pluginName: string, message: string, cause?: unknown): PluginLoadError =>
  new PluginLoadError({
    message: cause === undefined ? message : `${message}: ${String(cause)}`,
    pluginName,
  });

const packageRootPath = (packageRoot: string): string =>
  packageRoot.startsWith("file://") ? fileURLToPath(packageRoot) : packageRoot;

const realPathOrResolved = async (path: string): Promise<string> => realpath(path).catch(() => resolve(path));

const resolvePluginModulePath = async (
  packageRoot: string,
  pluginName: string,
  modulePath: string,
): Promise<string> => {
  const root = resolve(packageRoot);
  const candidate = modulePath.startsWith("file://")
    ? fileURLToPath(modulePath)
    : isAbsolute(modulePath)
      ? modulePath
      : resolve(root, modulePath);
  const resolved = resolve(candidate);
  const relativePath = relative(root, resolved);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw pluginLoadError(
      pluginName,
      `Plugin module ${modulePath} resolves outside the plugin package root ${root}.`,
    );
  }

  const realRoot = await realPathOrResolved(root);
  const realResolved = await realPathOrResolved(resolved);
  const realRelativePath = relative(realRoot, realResolved);
  if (realRelativePath.startsWith("..") || isAbsolute(realRelativePath)) {
    throw pluginLoadError(
      pluginName,
      `Plugin module ${modulePath} resolves through symlink outside the plugin package root ${root}.`,
    );
  }

  return resolved;
};

const loadExternalPluginEntry = async (packageRoot: string, manifest: PluginManifest): Promise<void> => {
  if (manifest.entry === undefined) return;
  const entryPath = await resolvePluginModulePath(packageRoot, String(manifest.name), manifest.entry);
  try {
    await import(pathToFileURL(entryPath).href);
  } catch (cause) {
    throw pluginLoadError(String(manifest.name), `Failed to import plugin entry ${manifest.entry}`, cause);
  }
};

const normalizeExternalContributionModules = async (
  packageRoot: string,
  manifest: PluginManifest,
): Promise<PluginManifest> => {
  const globalServices = manifest.contributes?.globalServices;
  const downloaders = manifest.contributes?.downloaders;
  const interactionServices = manifest.contributes?.interactionServices;
  if (globalServices === undefined && downloaders === undefined && interactionServices === undefined) {
    return manifest;
  }

  const normalizeContributionModulePath = async (modulePath: string): Promise<string> => {
    const resolved = await resolvePluginModulePath(packageRoot, String(manifest.name), modulePath);
    return pathToFileURL(resolved).href;
  };

  const normalizedGlobalServices =
    globalServices === undefined
      ? undefined
      : await Promise.all(
          globalServices.map(async (contribution) => {
            if (contribution.module === undefined) return contribution;
            return { ...contribution, module: await normalizeContributionModulePath(contribution.module) };
          }),
        );
  const normalizedDownloaders =
    downloaders === undefined
      ? undefined
      : await Promise.all(
          downloaders.map(async (contribution) => {
            if (contribution.module === undefined) return contribution;
            return { ...contribution, module: await normalizeContributionModulePath(contribution.module) };
          }),
        );
  const normalizedInteractionServices =
    interactionServices === undefined
      ? undefined
      : await Promise.all(
          interactionServices.map(async (contribution) => ({
            ...contribution,
            module: await normalizeContributionModulePath(contribution.module),
          })),
        );

  return {
    ...manifest,
    contributes: {
      ...manifest.contributes,
      ...(normalizedGlobalServices === undefined ? {} : { globalServices: normalizedGlobalServices }),
      ...(normalizedDownloaders === undefined ? {} : { downloaders: normalizedDownloaders }),
      ...(normalizedInteractionServices === undefined
        ? {}
        : { interactionServices: normalizedInteractionServices }),
    },
  };
};

const loadInstalledPluginManifest = async (packageRootInput: string): Promise<PluginManifest> => {
  const packageRoot = packageRootPath(packageRootInput);
  const packageJsonPath = join(packageRoot, "package.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(packageJsonPath, "utf8"));
  } catch (cause) {
    throw pluginManifestError(`Plugin package.json is invalid: ${packageJsonPath}`, cause);
  }
  const candidate = (parsed as { landoPlugin?: unknown }).landoPlugin ?? parsed;
  const decoded = Schema.decodeUnknownEither(PluginManifest)(candidate, { onExcessProperty: "error" });
  if (Either.isLeft(decoded)) {
    throw pluginManifestError(`Plugin manifest validation failed: ${packageJsonPath}`, decoded.left);
  }
  const manifest = await normalizeExternalContributionModules(packageRoot, decoded.right);
  await loadExternalPluginEntry(packageRoot, manifest);
  return manifest;
};

const warnPluginDiscoveryFailure = (
  logger: Context.Tag.Service<typeof Logger> | undefined,
  source: Exclude<PluginSourceKind, "system">,
  pluginName: string,
  cause: PluginManifestError | PluginLoadError,
): Effect.Effect<void> =>
  logger === undefined
    ? Effect.void
    : logger
        .warn(
          `Plugin discovery from ${source} source failed for ${pluginName}; skipping that plugin. ${cause._tag}: ${cause.message}`,
        )
        .pipe(Effect.catchAll(() => Effect.void));

const discoverInstalledPlugins = (
  source: Exclude<PluginSourceKind, "system">,
  pluginsRoot: string,
  logger: Context.Tag.Service<typeof Logger> | undefined,
): Effect.Effect<ReadonlyArray<DiscoveredPlugin>> =>
  Effect.tryPromise({
    try: async () => readInstalledPluginRegistry(pluginsRoot),
    catch: (cause) => pluginManifestError(`Failed to discover ${source} plugins from ${pluginsRoot}`, cause),
  }).pipe(
    Effect.flatMap((registry) =>
      Effect.forEach(Object.values(registry), (entry) =>
        Effect.tryPromise({
          try: async () => ({ source, manifest: await loadInstalledPluginManifest(entry.path) }),
          catch: (cause) =>
            cause instanceof PluginManifestError || cause instanceof PluginLoadError
              ? cause
              : pluginManifestError(
                  `Failed to discover ${source} plugin ${entry.name} from ${entry.path}`,
                  cause,
                ),
        }).pipe(
          Effect.map((plugin) => [plugin] as ReadonlyArray<DiscoveredPlugin>),
          Effect.catchAll((cause) =>
            Effect.as(
              warnPluginDiscoveryFailure(logger, source, entry.name, cause),
              [] as ReadonlyArray<DiscoveredPlugin>,
            ),
          ),
        ),
      ),
    ),
    Effect.map((plugins) => plugins.flat()),
    Effect.catchAll((cause) =>
      Effect.as(
        warnPluginDiscoveryFailure(logger, source, "registry", cause),
        [] as ReadonlyArray<DiscoveredPlugin>,
      ),
    ),
  );

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
  discovery: PluginRegistryDiscoveryOptions,
): Context.Tag.Service<typeof PluginRegistry> => {
  const disabled = new Set(discovery.disable ?? []);
  const discover = Effect.gen(function* () {
    const bundledPlugins = (discovery.bundled === false ? [] : systemPlugins).filter(
      (plugin) => !disabled.has(plugin.manifest.name),
    );
    if (configService === undefined) return bundledPlugins.map((plugin) => plugin.manifest);
    const userDataRoot = yield* configService
      .get("userDataRoot")
      .pipe(Effect.catchAll(() => Effect.succeed(undefined)));
    const userPlugins =
      discovery.user === false || userDataRoot === undefined
        ? []
        : yield* discoverInstalledPlugins("user", join(userDataRoot, "plugins"), logger);
    const appRoot =
      discovery.app === false ? undefined : yield* Effect.promise(() => findAppRoot(process.cwd()));
    const appPlugins =
      appRoot === undefined
        ? []
        : yield* discoverInstalledPlugins("app", join(appRoot, ".lando", "plugins"), logger);
    const manifests = yield* mergeDiscoveredPlugins([bundledPlugins, userPlugins, appPlugins], logger);
    return manifests.filter((manifest) => !disabled.has(manifest.name));
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
      if (discovery.bundled === false) {
        return Effect.fail(
          new PluginLoadError({
            message: `Bundled service type ${id} is not registered.`,
            pluginName: "@lando/core",
          }),
        );
      }

      for (const bundledPlugin of BUNDLED_PLUGINS) {
        if (disabled.has(bundledPlugin.manifest.name)) continue;
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

export const makePluginRegistryLive = (discovery: PluginRegistryDiscoveryOptions = {}) =>
  Layer.effect(
    PluginRegistry,
    Effect.gen(function* () {
      const configService = yield* Effect.serviceOption(ConfigService);
      const logger = yield* Effect.serviceOption(Logger);
      return makePluginRegistry(
        configService._tag === "Some" ? configService.value : undefined,
        logger._tag === "Some" ? logger.value : undefined,
        discovery,
      );
    }),
  );

export const PluginRegistryLive = makePluginRegistryLive();
