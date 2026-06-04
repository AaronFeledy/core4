/**
 * Generated/loaded OCLIF manifest helpers.
 *
 * OCLIF manifests must be precomputed. `oclif.manifest.json` is generated
 * at build time and embedded as an asset import. The user's installed
 * plugin manifests are cached at `<userConfRoot>/cache/oclif-manifest.json`
 * and refreshed on `plugin:add` / `plugin:remove`.
 */
import type { Interfaces } from "@oclif/core";

import { COMPILED_OCLIF_MANIFEST } from "./compiled-manifest.ts";

/**
 * Load the precomputed manifest for the binary build.
 */
export const loadCompiledManifest = (): Interfaces.Manifest => {
  return COMPILED_OCLIF_MANIFEST;
};
