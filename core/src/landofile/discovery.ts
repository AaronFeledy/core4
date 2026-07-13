import { dirname } from "node:path";

import { presentLandofileLayers, representativeLandofileLayer } from "./layers.ts";

export const LANDOFILE_NAME = ".lando.yml";
export const LANDOFILE_TS_NAME = ".lando.ts";

export const findLandofilePath = async (cwd: string): Promise<string | undefined> => {
  let current = cwd;
  for (;;) {
    const layer = representativeLandofileLayer(await presentLandofileLayers(current));
    if (layer !== undefined) return layer.filePath;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
};

export const findAppRoot = async (cwd: string): Promise<string | undefined> => {
  const filePath = await findLandofilePath(cwd);
  if (filePath === undefined) return undefined;
  return dirname(filePath);
};
