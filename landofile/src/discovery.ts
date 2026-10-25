import { Effect } from "effect";

import { presentLandofileLayers, representativeLandofileLayer } from "./layers.ts";
import { discoverForOperation } from "./operation-discovery.ts";

export const LANDOFILE_NAME = ".lando.yml";
export const LANDOFILE_TS_NAME = ".lando.ts";

export const findLandofilePath = Effect.fn("Landofile.findPath")(function* (cwd?: string) {
  const result = yield* discoverForOperation(cwd);
  if (result.kind === "stopped") return undefined;
  return representativeLandofileLayer(yield* presentLandofileLayers(result.directory))?.filePath;
});

export const findAppRoot = Effect.fn("Landofile.findAppRoot")(function* (cwd?: string) {
  const result = yield* discoverForOperation(cwd);
  return result.kind === "found" ? result.directory : undefined;
});
