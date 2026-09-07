/**
 * `ConfigTranslatorRegistry` Live: resolves `configTranslators:` contributions
 * from every plugin source (bundled, system, user, app, and host-injected)
 * through the contribution graph.
 *
 * Nothing loads when the layer is built. Candidate metadata is read from the
 * plugin descriptors on the first `list`, and each lazy loader runs at most
 * once, so help, version, ordinary loading, and tooling paths never construct
 * translator factories. Duplicate ids across sources fail `list` with a
 * `ConfigTranslatorConflictError` naming both producers; no source wins.
 * Manifest and descriptor id sets must agree or `list` fails with
 * `PluginDescriptorMismatchError` before any factory runs.
 * Duplicates inside the bundled set are already rejected by the module-set
 * index at plugin bootstrap.
 */
import { Effect, Layer, Option } from "effect";

import {
  ConfigTranslatorConflictError,
  PluginDescriptorMismatchError,
  PluginLoadError,
} from "@lando/sdk/errors";
import type { ConfigTranslatorLoader, LandoPluginModule } from "@lando/sdk/plugins";
import { ConfigTranslatorRegistry, type ConfigTranslatorShape } from "@lando/sdk/services";

import { bundledPluginModules } from "../composition.ts";
import { type LoadedPluginContribution, PluginContributionGraph } from "./contribution-graph.ts";
import { systemPluginsFromModules } from "./plugin-discovery.ts";

interface ConfigTranslatorCandidate {
  readonly id: string;
  readonly pluginName: string;
  readonly source: LoadedPluginContribution["source"];
  readonly load: ConfigTranslatorLoader;
}

const translatorLoaders = (plugin: LoadedPluginContribution): ReadonlyMap<string, ConfigTranslatorLoader> => {
  const direct = plugin.entry?.configTranslators ?? plugin.module?.configTranslators;
  if (direct instanceof Map) return direct;
  const nested = plugin.module !== undefined && "plugin" in plugin.module ? plugin.module.plugin : undefined;
  if (
    typeof nested === "object" &&
    nested !== null &&
    "configTranslators" in nested &&
    nested.configTranslators instanceof Map
  ) {
    return nested.configTranslators;
  }
  return new Map();
};

/**
 * Collect translator candidates in plugin order. Loader ids must match the
 * plugin's manifest `configTranslators:` ids. The first duplicate id fails
 * with both producing plugin names; neither contribution is kept.
 */
const sameTranslatorIds = (declared: ReadonlyArray<string>, provided: ReadonlyArray<string>): boolean => {
  const left = [...declared].sort();
  const right = [...provided].sort();
  return left.length === right.length && left.every((id, index) => id === right[index]);
};

const configTranslatorCandidates = (
  plugins: ReadonlyArray<LoadedPluginContribution>,
): Effect.Effect<
  ReadonlyArray<ConfigTranslatorCandidate>,
  ConfigTranslatorConflictError | PluginDescriptorMismatchError
> => {
  const candidates: Array<ConfigTranslatorCandidate> = [];
  const owners = new Map<string, ConfigTranslatorCandidate>();
  for (const plugin of plugins) {
    const pluginName = String(plugin.manifest.name);
    const loaders = translatorLoaders(plugin);
    const declared = (plugin.manifest.contributes?.configTranslators ?? []).map(
      (contribution) => contribution.id,
    );
    const provided = [...loaders.keys()];
    if (!sameTranslatorIds(declared, provided)) {
      return Effect.fail(
        new PluginDescriptorMismatchError({
          pluginName,
          kind: "configTranslators",
          declared,
          provided,
          message: `Plugin ${pluginName} manifest and descriptor disagree for configTranslators.`,
          remediation: `Align ${pluginName}'s manifest configTranslators ids with its descriptor configTranslators ids.`,
        }),
      );
    }
    for (const [id, load] of loaders) {
      const owner = owners.get(id);
      if (owner !== undefined) {
        return Effect.fail(
          new ConfigTranslatorConflictError({
            message: `Config translator id ${id} is contributed by both ${owner.pluginName} (${owner.source}) and ${pluginName} (${plugin.source}).`,
            id,
            translators: [owner.pluginName, pluginName],
            remediation: `Disable or rename the translator ${id} in one of ${owner.pluginName} or ${pluginName}; no plugin source takes precedence.`,
          }),
        );
      }
      const candidate: ConfigTranslatorCandidate = { id, pluginName, source: plugin.source, load };
      owners.set(id, candidate);
      candidates.push(candidate);
    }
  }
  return Effect.succeed(candidates);
};

const loadCandidate = (
  candidate: ConfigTranslatorCandidate,
): Effect.Effect<ConfigTranslatorShape, PluginLoadError> =>
  Effect.tryPromise({
    try: () => candidate.load(),
    catch: (cause) =>
      new PluginLoadError({
        message: `Config translator ${candidate.id} from ${candidate.pluginName} failed to load.`,
        pluginName: candidate.pluginName,
        cause,
      }),
  }).pipe(
    Effect.flatMap((translator) =>
      translator.id === candidate.id
        ? Effect.succeed(translator)
        : Effect.fail(
            new PluginLoadError({
              message: `Config translator contribution ${candidate.id} from ${candidate.pluginName} loaded a translator with id ${translator.id}.`,
              pluginName: candidate.pluginName,
            }),
          ),
    ),
  );

const bundledContributions = (
  modules: ReadonlyArray<LandoPluginModule>,
): ReadonlyArray<LoadedPluginContribution> =>
  systemPluginsFromModules(modules).map((plugin, index) => {
    const entry = modules[index];
    return entry === undefined ? plugin : { ...plugin, entry };
  });

export const makeConfigTranslatorRegistryLive = (
  modules: ReadonlyArray<LandoPluginModule> = bundledPluginModules(),
): Layer.Layer<ConfigTranslatorRegistry> =>
  Layer.effect(
    ConfigTranslatorRegistry,
    Effect.gen(function* () {
      const graph = yield* Effect.serviceOption(PluginContributionGraph);
      const plugins = Option.isSome(graph) ? graph.value.plugins : bundledContributions(modules);
      const list = yield* Effect.cached(
        configTranslatorCandidates(plugins).pipe(
          Effect.flatMap((candidates) => Effect.forEach(candidates, loadCandidate)),
        ),
      );
      return ConfigTranslatorRegistry.of({ list });
    }),
  );

export const ConfigTranslatorRegistryLive = Layer.suspend(() => makeConfigTranslatorRegistryLive());
