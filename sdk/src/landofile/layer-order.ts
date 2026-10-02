import type { LandofileLayer } from "../schema/landofile-reference.ts";

/** Default Landofile layer order, low → high precedence. */
export const LANDOFILE_LAYER_ORDER: ReadonlyArray<LandofileLayer> = [
  "base",
  "dist",
  "upstream",
  "canonical",
  "local",
  "user",
];

/** Index in {@link LANDOFILE_LAYER_ORDER}. An unknown layer ranks after every known layer. */
export const landofileLayerRank = (layer: LandofileLayer): number => {
  const index = LANDOFILE_LAYER_ORDER.indexOf(layer);
  return index === -1 ? LANDOFILE_LAYER_ORDER.length : index;
};
