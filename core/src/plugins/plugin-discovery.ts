/**
 * Installed-plugin discovery and contribution lookup.
 *
 * Walks the user/app installed-plugin registries (loading each package through
 * {@link loadInstalledPlugin}), tolerates and logs per-plugin failures, and
 * merges sources with last-source-wins override semantics. Also holds the
 * predicates/finders that resolve a service type or app feature from a bundled
 * or external plugin's imported module.
 */
import { type Context, Effect } from "effect";

import { PluginLoadError, PluginManifestError } from "@lando/sdk/errors";
import type { PluginManifest } from "@lando/sdk/schema";
import type { Logger } from "@lando/sdk/services";
import type { AppFeatureDefinition, ServiceType } from "@lando/sdk/services";

import { BUNDLED_PLUGINS } from "./bundled.ts";
import { type ExternalPluginModule, loadInstalledPlugin } from "./installed-plugin-loader.ts";
import { readInstalledPluginRegistry } from "./installed-registry.ts";
import { pluginManifestError } from "./plugin-module-path.ts";

export type PluginSourceKind = "system" | "user" | "app";

export interface DiscoveredPlugin {
  readonly source: PluginSourceKind;
  readonly manifest: PluginManifest;
  readonly module?: ExternalPluginModule;
}

const isAppFeature = (value: unknown): value is AppFeatureDefinition =>
  typeof value === "object" &&
  value !== null &&
  "id" in value &&
  typeof value.id === "string" &&
  "priority" in value &&
  typeof value.priority === "number" &&
  "apply" in value &&
  typeof value.apply === "function";

/**
 * An app feature must declare at least one of `activatedBy` or `selectors`.
 * An entry with neither is unscoped (it would run on every service draft) and
 * is rejected at load.
 */
const isScopedAppFeature = (feature: AppFeatureDefinition): boolean =>
  feature.activatedBy !== undefined || feature.selectors !== undefined;

export const ensureScopedAppFeature = (
  feature: AppFeatureDefinition,
): Effect.Effect<AppFeatureDefinition, PluginLoadError> =>
  isScopedAppFeature(feature)
    ? Effect.succeed(feature)
    : Effect.fail(
        new PluginLoadError({
          message: `App feature ${feature.id} declares neither activatedBy nor selectors; it must declare at least one.`,
          pluginName: "@lando/core",
        }),
      );

export const externalAppFeature = (
  plugin: DiscoveredPlugin,
  id: string,
): AppFeatureDefinition | undefined => {
  const appFeatures = plugin.module?.appFeatures;
  if (!(appFeatures instanceof Map)) return undefined;
  const feature = appFeatures.get(id);
  return isAppFeature(feature) ? feature : undefined;
};

const isServiceType = (value: unknown): value is ServiceType =>
  typeof value === "object" &&
  value !== null &&
  "id" in value &&
  typeof value.id === "string" &&
  "resolve" in value &&
  typeof value.resolve === "function";

const externalServiceType = (plugin: DiscoveredPlugin, id: string): ServiceType | undefined => {
  const serviceTypes = plugin.module?.serviceTypes;
  if (!(serviceTypes instanceof Map)) return undefined;
  const serviceType = serviceTypes.get(id);
  return isServiceType(serviceType) ? serviceType : undefined;
};

export const findExternalServiceType = (
  plugins: ReadonlyArray<DiscoveredPlugin>,
  id: string,
): ServiceType | undefined => {
  for (const plugin of plugins) {
    if (plugin.source === "system") continue;
    const serviceType = externalServiceType(plugin, id);
    if (serviceType !== undefined) return serviceType;
  }
  return undefined;
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

export const discoverInstalledPlugins = (
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
          try: async () => ({ source, ...(await loadInstalledPlugin(entry.path)) }),
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

export const mergeDiscoveredPlugins = (
  sources: ReadonlyArray<ReadonlyArray<DiscoveredPlugin>>,
  logger: Context.Tag.Service<typeof Logger> | undefined,
): Effect.Effect<ReadonlyArray<DiscoveredPlugin>> =>
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
    return [...merged.values()];
  });

export const systemPlugins: ReadonlyArray<DiscoveredPlugin> = BUNDLED_PLUGINS.map((plugin) => ({
  source: "system" as const,
  manifest: plugin.manifest,
}));

export const findBundledServiceType = (
  id: string,
  disabled: ReadonlySet<string>,
): ServiceType | undefined => {
  for (const bundledPlugin of BUNDLED_PLUGINS) {
    if (disabled.has(bundledPlugin.manifest.name)) continue;
    const serviceType = bundledPlugin.serviceTypes?.get(id);
    if (serviceType !== undefined) return serviceType;
  }
  return undefined;
};
