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
  /** Contribution summary embedded in the bundled manifest. */
  readonly contributes?: {
    readonly providers?: ReadonlyArray<string>;
    readonly serviceTypes?: ReadonlyArray<string>;
    readonly loggers?: ReadonlyArray<string>;
  };
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
    { name: "@lando/provider-lando", path: "plugins/provider-lando", contributes: { providers: ["lando"] } },
    {
      name: "@lando/provider-docker",
      path: "plugins/provider-docker",
      contributes: { providers: ["docker"] },
    },
    {
      name: "@lando/service-lando",
      path: "plugins/service-lando",
      contributes: { serviceTypes: ["node:lts", "postgres"] },
    },
    { name: "@lando/logger-pretty", path: "plugins/logger-pretty", contributes: { loggers: ["pretty"] } },
  ],
  bundledRecipes: [
    { id: "node-postgres" },
    { id: "wordpress" },
    { id: "laravel" },
    { id: "symfony" },
    { id: "lamp" },
    { id: "lemp" },
    { id: "node-api" },
    { id: "astro" },
    { id: "sveltekit" },
    { id: "nextjs" },
    { id: "django" },
    { id: "fastapi" },
    { id: "rails" },
    { id: "jekyll" },
    { id: "hugo" },
    { id: "eleventy" },
    { id: "empty" },
    { id: "node-ts" },
  ],
  bundledPluginTemplates: [],
};
