/**
 * Generated/loaded OCLIF manifest helpers.
 *
 * OCLIF manifests must be precomputed. `oclif.manifest.json` is generated
 * at build time and embedded as an asset import. The user's installed
 * plugin manifests are cached at `<userConfRoot>/cache/oclif-manifest.json`
 * and refreshed on `plugin:add` / `plugin:remove`.
 *
 * Status: stub.
 */
import type { Interfaces } from "@oclif/core";

/**
 * Load the precomputed `oclif.manifest.json` for the binary build.
 *
 * TODO: once the build pipeline lands, this loads the embedded
 * manifest asset. Until then, returns a synthetic empty manifest.
 */
export const loadCompiledManifest = (): Interfaces.Manifest => {
  // Synthetic empty manifest until the build pipeline lands.
  return { version: "0.0.0", commands: {} } satisfies Interfaces.Manifest;
};
