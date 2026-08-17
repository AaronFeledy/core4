import type { RendererContribution } from "@lando/sdk/renderer";

import { BUNDLED_RENDERER_MODULES } from "../../plugins/generated/renderers";

/**
 * The renderer contributions supplied by bundled renderer plugins. Each plugin
 * owns and exports its finished `RendererContribution`; core only resolves the
 * contribution here — it does not assemble the renderer from parts.
 */
const buildRegistry = (): ReadonlyMap<string, RendererContribution> => {
  const registry = new Map<string, RendererContribution>();
  for (const module of BUNDLED_RENDERER_MODULES) {
    for (const contribution of module.renderers?.values() ?? []) {
      if (!registry.has(contribution.id)) registry.set(contribution.id, contribution);
    }
  }
  return registry;
};

export const bundledRendererRegistry: ReadonlyMap<string, RendererContribution> = buildRegistry();

export const resolveBundledRenderer = (id: string): RendererContribution => {
  const contribution = bundledRendererRegistry.get(id);
  if (contribution === undefined) {
    throw new Error(`Bundled renderer "${id}" is not registered by any bundled renderer plugin.`);
  }
  return contribution;
};

export const landoRenderer: RendererContribution = resolveBundledRenderer("lando");
