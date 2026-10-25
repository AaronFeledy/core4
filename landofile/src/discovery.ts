import { dirname } from "node:path";
import { Effect } from "effect";

import { landofileLayerPaths, presentLandofileLayers, representativeLandofileLayer } from "./layers.ts";

export const LANDOFILE_NAME = ".lando.yml";
export const LANDOFILE_TS_NAME = ".lando.ts";

export const findLandofilePath = Effect.fn("Landofile.findPath")(function* (cwd: string) {
  let current = cwd;
  for (;;) {
    const layer = representativeLandofileLayer(yield* presentLandofileLayers(current));
    if (layer !== undefined) return layer.filePath;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
});

export const findAppRoot = Effect.fn("Landofile.findAppRoot")(function* (cwd: string) {
  let current = cwd;
  for (;;) {
    for (const { yamlPath, typescriptPath } of landofileLayerPaths(current)) {
      const present = yield* Effect.promise(() =>
        Promise.all([Bun.file(yamlPath).exists(), Bun.file(typescriptPath).exists()]),
      );
      if (present.some(Boolean)) return current;
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
});
