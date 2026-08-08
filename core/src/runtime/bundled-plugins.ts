import { installEngineComposition } from "@lando/engine/composition";
import { BUNDLED_PLUGIN_MODULES } from "../plugins/generated/bundled";
import { baseEngineCompositionInputs } from "./engine-composition";

installEngineComposition({
  ...baseEngineCompositionInputs,
  bundledPluginModules: BUNDLED_PLUGIN_MODULES,
  landofileRuntimeInputs: {
    ...baseEngineCompositionInputs.landofileRuntimeInputs,
    templates: { modules: BUNDLED_PLUGIN_MODULES },
  },
});

export { BUNDLED_PLUGIN_MODULES };
