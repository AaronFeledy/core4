import { bundledPluginModules } from "@lando/engine/composition";
import * as DeprecationPluginRegistry from "@lando/engine/deprecation/plugin-registry";
import * as ConfigTranslatorRegistryLayer from "@lando/engine/plugins/config-translator-registry";
import * as PluginContributionGraphLayer from "@lando/engine/plugins/contribution-graph";
import * as PluginRegistryLayer from "@lando/engine/plugins/registry";
import { EventService } from "@lando/sdk/services";
import { Context, Layer } from "effect";
import * as BuiltInCommandCatalogLayer from "../../cli/built-in-command-catalog-live.ts";
import { type MinimalBootstrapLayerInputs, minimalBootstrapLayerFor } from "./minimal.ts";

export const makePluginsBootstrapBaseLayer = (inputs: MinimalBootstrapLayerInputs) => {
  const minimalRuntimeGraph = minimalBootstrapLayerFor(inputs);
  const minimalRuntimeLayer = Layer.suspend(() => minimalRuntimeGraph);
  const contributionGraphLayer = PluginContributionGraphLayer.PluginContributionGraph.layer(
    {
      layers: inputs.pluginLayers,
      manifests: inputs.pluginManifests,
      discovery: inputs.pluginDiscovery,
      externalImports: inputs.externalImports,
      cwd: inputs.cwd,
    },
    bundledPluginModules(),
  ).pipe(Layer.provide(minimalRuntimeLayer));
  const pluginRegistryLayer = PluginRegistryLayer.layerWith(
    inputs.pluginDiscovery,
    bundledPluginModules(),
  ).pipe(Layer.provide(Layer.merge(minimalRuntimeLayer, contributionGraphLayer)));
  const deprecationRegistryLayer = DeprecationPluginRegistry.layer.pipe(
    Layer.provide(Layer.mergeAll(minimalRuntimeLayer, pluginRegistryLayer)),
  );
  const configTranslatorRegistryLayer = ConfigTranslatorRegistryLayer.layerWith(bundledPluginModules()).pipe(
    Layer.provide(Layer.merge(minimalRuntimeLayer, contributionGraphLayer)),
  );
  return Layer.mergeAll(
    minimalRuntimeLayer,
    contributionGraphLayer,
    pluginRegistryLayer,
    deprecationRegistryLayer,
    configTranslatorRegistryLayer,
    BuiltInCommandCatalogLayer.layer,
  ).pipe(Layer.tap((context) => inputs.lifecycle.complete("plugins", Context.get(context, EventService))));
};
