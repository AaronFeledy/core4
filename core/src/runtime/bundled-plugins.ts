import { type EngineCompositionInputs, installEngineComposition } from "@lando/engine/composition";
import { BUNDLED_PLUGIN_MODULES } from "../plugins/generated/bundled";
import { baseEngineCompositionInputs } from "./engine-composition";

/** Engine composition with every bundled plugin, installed when this module loads. */
export const bundledEngineCompositionInputs: EngineCompositionInputs = {
  ...baseEngineCompositionInputs,
  bundledPluginModules: BUNDLED_PLUGIN_MODULES,
  landofileRuntimeInputs: {
    ...baseEngineCompositionInputs.landofileRuntimeInputs,
    templates: { modules: BUNDLED_PLUGIN_MODULES },
  },
};

installEngineComposition(bundledEngineCompositionInputs);

export { BUNDLED_PLUGIN_MODULES };
