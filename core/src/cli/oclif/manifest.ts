/**
 * Generated/loaded OCLIF manifest helpers.
 *
 * OCLIF manifests must be precomputed. `oclif.manifest.json` and this module's
 * `compiled-manifest.ts` dependency are generated together at build time.
 * Installed plugin command metadata lives in the separate plugin-command cache,
 * which plugin mutations invalidate rather than rewriting this manifest.
 */
import { COMPILED_OCLIF_MANIFEST } from "./compiled-manifest.ts";
import type { Manifest } from "./metadata.ts";

/**
 * Load the precomputed manifest for the binary build.
 */
export const loadCompiledManifest = (): Manifest => {
  return COMPILED_OCLIF_MANIFEST;
};
