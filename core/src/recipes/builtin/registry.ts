/**
 * Built-in recipe renderer registry.
 *
 * Renderers are statically imported so they are reachable inside the
 * `bun build --compile` binary without any runtime FS or dynamic import.
 * The init flow iterates `manifest.files` and looks each `dest` up in
 * the rendered map. Missing entries fail with a tagged error.
 */
import type { PromptAnswers } from "../prompts/runtime";

import { astroRenderer } from "./astro/render";
import { djangoRenderer } from "./django/render";
import { drupalCmsRenderer } from "./drupal-cms/render";
import { drupalRenderer } from "./drupal/render";
import { eleventyRenderer } from "./eleventy/render";
import { emptyRenderer } from "./empty/render";
import { fastapiRenderer } from "./fastapi/render";
import { hugoRenderer } from "./hugo/render";
import { jekyllRenderer } from "./jekyll/render";
import { lampRenderer } from "./lamp/render";
import { laravelRenderer } from "./laravel/render";
import { lempRenderer } from "./lemp/render";
import { nextjsRenderer } from "./nextjs/render";
import { nodeApiRenderer } from "./node-api/render";
import { nodePostgresRenderer } from "./node-postgres/render";
import { nodeTsRenderer } from "./node-ts/render";
import { railsRenderer } from "./rails/render";
import { sveltekitRenderer } from "./sveltekit/render";
import { symfonyRenderer } from "./symfony/render";
import { toolboxRenderer } from "./toolbox/render";
import { wordpressRenderer } from "./wordpress/render";

/** Map of recipe file dest → rendered content. */
export type RecipeFileMap = ReadonlyMap<string, string>;

export interface RecipeRenderInput {
  /** Validated app name (kebab-case) drawn from the `name` prompt answer. */
  readonly appName: string;
  /** All collected prompt answers, keyed by prompt name. */
  readonly answers: PromptAnswers;
}

export interface RecipeRenderer {
  /** Recipe id matching the parent directory and the manifest `id:` field. */
  readonly id: string;
  /** Pure function: returns `dest → content` for every file the recipe writes. */
  readonly render: (input: RecipeRenderInput) => RecipeFileMap;
}

const RENDERERS = [
  nodePostgresRenderer,
  wordpressRenderer,
  laravelRenderer,
  symfonyRenderer,
  lampRenderer,
  lempRenderer,
  nodeApiRenderer,
  astroRenderer,
  sveltekitRenderer,
  nextjsRenderer,
  djangoRenderer,
  drupalRenderer,
  drupalCmsRenderer,
  fastapiRenderer,
  railsRenderer,
  jekyllRenderer,
  hugoRenderer,
  eleventyRenderer,
  emptyRenderer,
  nodeTsRenderer,
  toolboxRenderer,
] as const satisfies ReadonlyArray<RecipeRenderer>;

/**
 * Registry keyed by recipe id. Used by `initApp` to resolve the renderer
 * for a bundled recipe.
 */
export const BUILTIN_RECIPE_RENDERERS: ReadonlyMap<string, RecipeRenderer> = new Map(
  RENDERERS.map((renderer) => [renderer.id, renderer] as const),
);

/** Returns the renderer registered for `recipeId`, or `undefined`. */
export const lookupRecipeRenderer = (recipeId: string): RecipeRenderer | undefined =>
  BUILTIN_RECIPE_RENDERERS.get(recipeId);

/** Convenience: ordered list of bundled recipe ids (for tests/docs). */
export const builtinRecipeIds = (): ReadonlyArray<string> => RENDERERS.map((renderer) => renderer.id);
