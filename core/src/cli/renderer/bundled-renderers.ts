import type { RendererContribution } from "@lando/sdk/renderer";

import { renderer as landoRendererContribution } from "@lando/renderer-lando";
export { makeNotificationConsumer as makeLandoNotificationConsumer } from "@lando/renderer-lando";

/**
 * The renderer contributions supplied by bundled renderer plugins. Each plugin
 * owns and exports its finished `RendererContribution`; core only resolves the
 * contribution here — it does not assemble the renderer from parts.
 */
const bundledRendererContributions: ReadonlyArray<RendererContribution> = [landoRendererContribution];

const buildRegistry = (): ReadonlyMap<string, RendererContribution> => {
  const registry = new Map<string, RendererContribution>();
  for (const contribution of bundledRendererContributions) {
    if (!registry.has(contribution.id)) registry.set(contribution.id, contribution);
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
