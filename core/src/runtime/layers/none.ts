import { builtInCommandIds, bundledPluginModules } from "@lando/engine/composition";
import type { BootstrapLayerInputs } from "@lando/engine/runtime/bootstrap-layer-support";
import { RuntimeLayerFactory } from "@lando/engine/runtime/runtime-layer-factory";
import { GlobalConfigSources } from "@lando/engine/services/config";
import { Layer } from "effect";

export const makeNoneBootstrapLayer = (inputs: BootstrapLayerInputs) =>
  Layer.mergeAll(
    Layer.succeed(RuntimeLayerFactory, inputs.runtimeLayerFactory),
    Layer.succeed(GlobalConfigSources, {
      commandIds: builtInCommandIds(),
      commandPlugins: {
        manifests: inputs.pluginDiscovery.bundled
          ? bundledPluginModules().map((module) => module.manifest)
          : [],
        explicit: inputs.pluginManifests.map((input) => input.manifest),
        system: inputs.externalImports && inputs.pluginDiscovery.system,
        user: inputs.externalImports && inputs.pluginDiscovery.user,
        disable: inputs.pluginDiscovery.disable,
      },
      ...inputs.configInputs,
    }),
  );
