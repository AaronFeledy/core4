/**
 * **GENERATED FILE** — do not edit by hand.
 *
 * Regenerate via `bun run scripts/build-bundled-recipes.ts`.
 *
 * Source of truth: `core/build.config.ts` (the "ship list").
 *
 * The default Lando v4 binary is built with `bun build --compile`. Compiled
 * binaries cannot dynamically `import()` arbitrary files at runtime, so
 * bundled recipe manifests are statically imported here. The compiled binary
 * does NOT read recipe.yml from disk at runtime — the manifest text is
 * embedded in the binary as a TypeScript string constant.
 */

import { ASTRO_RECIPE_ID, astroRecipeSource, astroRecipeYaml } from "./builtin/astro/manifest.ts";
import { DJANGO_RECIPE_ID, djangoRecipeSource, djangoRecipeYaml } from "./builtin/django/manifest.ts";
import { ELEVENTY_RECIPE_ID, eleventyRecipeSource, eleventyRecipeYaml } from "./builtin/eleventy/manifest.ts";
import { EMPTY_RECIPE_ID, emptyRecipeSource, emptyRecipeYaml } from "./builtin/empty/manifest.ts";
import { FASTAPI_RECIPE_ID, fastapiRecipeSource, fastapiRecipeYaml } from "./builtin/fastapi/manifest.ts";
import { HUGO_RECIPE_ID, hugoRecipeSource, hugoRecipeYaml } from "./builtin/hugo/manifest.ts";
import { JEKYLL_RECIPE_ID, jekyllRecipeSource, jekyllRecipeYaml } from "./builtin/jekyll/manifest.ts";
import { LAMP_RECIPE_ID, lampRecipeSource, lampRecipeYaml } from "./builtin/lamp/manifest.ts";
import { LARAVEL_RECIPE_ID, laravelRecipeSource, laravelRecipeYaml } from "./builtin/laravel/manifest.ts";
import { LEMP_RECIPE_ID, lempRecipeSource, lempRecipeYaml } from "./builtin/lemp/manifest.ts";
import { NEXTJS_RECIPE_ID, nextjsRecipeSource, nextjsRecipeYaml } from "./builtin/nextjs/manifest.ts";
import { NODE_API_RECIPE_ID, nodeApiRecipeSource, nodeApiRecipeYaml } from "./builtin/node-api/manifest.ts";
import {
  NODE_POSTGRES_RECIPE_ID,
  nodePostgresRecipeSource,
  nodePostgresRecipeYaml,
} from "./builtin/node-postgres/manifest.ts";
import { RAILS_RECIPE_ID, railsRecipeSource, railsRecipeYaml } from "./builtin/rails/manifest.ts";
import {
  SVELTEKIT_RECIPE_ID,
  sveltekitRecipeSource,
  sveltekitRecipeYaml,
} from "./builtin/sveltekit/manifest.ts";
import { SYMFONY_RECIPE_ID, symfonyRecipeSource, symfonyRecipeYaml } from "./builtin/symfony/manifest.ts";
import {
  WORDPRESS_RECIPE_ID,
  wordpressRecipeSource,
  wordpressRecipeYaml,
} from "./builtin/wordpress/manifest.ts";

export interface BundledRecipe {
  readonly id: string;
  readonly source: string;
  readonly manifestYaml: string;
}

export const BUNDLED_RECIPES: ReadonlyArray<BundledRecipe> = [
  {
    id: NODE_POSTGRES_RECIPE_ID,
    source: nodePostgresRecipeSource,
    manifestYaml: nodePostgresRecipeYaml,
  },
  {
    id: WORDPRESS_RECIPE_ID,
    source: wordpressRecipeSource,
    manifestYaml: wordpressRecipeYaml,
  },
  {
    id: LARAVEL_RECIPE_ID,
    source: laravelRecipeSource,
    manifestYaml: laravelRecipeYaml,
  },
  {
    id: SYMFONY_RECIPE_ID,
    source: symfonyRecipeSource,
    manifestYaml: symfonyRecipeYaml,
  },
  {
    id: LAMP_RECIPE_ID,
    source: lampRecipeSource,
    manifestYaml: lampRecipeYaml,
  },
  {
    id: LEMP_RECIPE_ID,
    source: lempRecipeSource,
    manifestYaml: lempRecipeYaml,
  },
  {
    id: NODE_API_RECIPE_ID,
    source: nodeApiRecipeSource,
    manifestYaml: nodeApiRecipeYaml,
  },
  {
    id: ASTRO_RECIPE_ID,
    source: astroRecipeSource,
    manifestYaml: astroRecipeYaml,
  },
  {
    id: SVELTEKIT_RECIPE_ID,
    source: sveltekitRecipeSource,
    manifestYaml: sveltekitRecipeYaml,
  },
  {
    id: NEXTJS_RECIPE_ID,
    source: nextjsRecipeSource,
    manifestYaml: nextjsRecipeYaml,
  },
  {
    id: DJANGO_RECIPE_ID,
    source: djangoRecipeSource,
    manifestYaml: djangoRecipeYaml,
  },
  {
    id: FASTAPI_RECIPE_ID,
    source: fastapiRecipeSource,
    manifestYaml: fastapiRecipeYaml,
  },
  {
    id: RAILS_RECIPE_ID,
    source: railsRecipeSource,
    manifestYaml: railsRecipeYaml,
  },
  {
    id: JEKYLL_RECIPE_ID,
    source: jekyllRecipeSource,
    manifestYaml: jekyllRecipeYaml,
  },
  {
    id: HUGO_RECIPE_ID,
    source: hugoRecipeSource,
    manifestYaml: hugoRecipeYaml,
  },
  {
    id: ELEVENTY_RECIPE_ID,
    source: eleventyRecipeSource,
    manifestYaml: eleventyRecipeYaml,
  },
  {
    id: EMPTY_RECIPE_ID,
    source: emptyRecipeSource,
    manifestYaml: emptyRecipeYaml,
  },
];
