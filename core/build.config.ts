/**
 * Lando v4 build configuration — the bundled-artifact "ship list".
 *
 * Read by:
 *   - `scripts/build-bundled-plugins.ts` (regenerates `src/plugins/bundled.ts`)
 *   - `scripts/build-bundled-recipes.ts` (regenerates `src/recipes/bundled.ts`)
 *   - `scripts/build-bundled-plugin-templates.ts`
 *   - `scripts/codegen.ts` (the orchestrator)
 *   - `scripts/release.ts` (the release pipeline)
 *
 * Removing an entry here and rebuilding produces a binary that omits the
 * artifact without any code edit under `src/`.
 */

export interface BundledPluginEntry {
  /** Plugin package name (resolves through the workspace). */
  readonly name: string;
  /** Workspace path relative to the repo root. */
  readonly path: string;
}

export interface BundledRecipeEntry {
  /** Recipe id (matches the directory name under `recipes/<id>/`). */
  readonly id: string;
}

export interface BundledPluginTemplateEntry {
  /** Template id (matches the directory under `plugin-templates/<id>/`). */
  readonly id: string;
}

export interface BuildConfig {
  readonly bundledPlugins: ReadonlyArray<BundledPluginEntry>;
  readonly bundledRecipes: ReadonlyArray<BundledRecipeEntry>;
  readonly bundledPluginTemplates: ReadonlyArray<BundledPluginTemplateEntry>;
}

export const buildConfig: BuildConfig = {
  bundledPlugins: [
    // The reference plugins under `plugins/` are still scaffolding stubs
    // (`PLUGIN_NAME` exports only). They are intentionally NOT shipped in
    // the binary until each plugin's runtime Layer lands. Re-add an entry
    // here when the plugin's `src/index.ts` exports a usable `Layer`.
    //
    // { name: "@lando/service-lando", path: "plugins/service-lando" },
    // { name: "@lando/provider-docker", path: "plugins/provider-docker" },
    // { name: "@lando/proxy-traefik", path: "plugins/proxy-traefik" },
    // { name: "@lando/ca-mkcert", path: "plugins/ca-mkcert" },
    // { name: "@lando/logger-pretty", path: "plugins/logger-pretty" },
    // { name: "@lando/renderer-listr", path: "plugins/renderer-listr" },
  ],
  bundledRecipes: [],
  bundledPluginTemplates: [],
};
