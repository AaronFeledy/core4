import type { RendererContribution } from "@lando/sdk/renderer";

import { rendererFactories } from "@lando/renderer-lando";

import { coreLandoRendererPrimitives } from "./runtime.ts";

const buildRegistry = (): ReadonlyMap<string, RendererContribution> => {
  const registry = new Map<string, RendererContribution>();
  for (const [id, factory] of rendererFactories) {
    if (!registry.has(id)) registry.set(id, factory.make(coreLandoRendererPrimitives));
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
