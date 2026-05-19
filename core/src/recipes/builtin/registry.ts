/**
 * Built-in recipe renderer registry.
 *
 * Renderers are statically imported so they are reachable inside the
 * `bun build --compile` binary without any runtime FS or dynamic import.
 * The init flow iterates `manifest.files` and looks each `dest` up in
 * the rendered map. Missing entries fail with a tagged error.
 */
import type { PromptAnswers } from "../prompts/runtime.ts";

import { astroRenderer } from "./astro/render.ts";
import { djangoRenderer } from "./django/render.ts";
import { eleventyRenderer } from "./eleventy/render.ts";
import { emptyRenderer } from "./empty/render.ts";
import { fastapiRenderer } from "./fastapi/render.ts";
import { hugoRenderer } from "./hugo/render.ts";
import { jekyllRenderer } from "./jekyll/render.ts";
import { lampRenderer } from "./lamp/render.ts";
import { laravelRenderer } from "./laravel/render.ts";
import { lempRenderer } from "./lemp/render.ts";
import { nextjsRenderer } from "./nextjs/render.ts";
import { nodeApiRenderer } from "./node-api/render.ts";
import { nodePostgresRenderer } from "./node-postgres/render.ts";
import { railsRenderer } from "./rails/render.ts";
import { sveltekitRenderer } from "./sveltekit/render.ts";
import { symfonyRenderer } from "./symfony/render.ts";
import { wordpressRenderer } from "./wordpress/render.ts";

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
  fastapiRenderer,
  railsRenderer,
  jekyllRenderer,
  hugoRenderer,
  eleventyRenderer,
  emptyRenderer,
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
