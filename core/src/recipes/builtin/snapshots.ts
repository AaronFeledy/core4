/**
 * Bundled recipe declarative current snapshots.
 *
 * Each entry is the inert, safely renderable current-version snapshot its
 * recipe publishes alongside its decomposer. Rendering a snapshot never runs
 * recipe code, so provenance readers such as `app:config:explain` can compare a
 * user's Landofile against generated authoring data without executing anything.
 */
import type { RecipeSnapshot } from "@lando/sdk/schema";

import { astroSnapshot } from "./astro/snapshot.ts";
import { backdropSnapshot } from "./backdrop/snapshot.ts";
import { djangoSnapshot } from "./django/snapshot.ts";
import { drupalCmsSnapshot } from "./drupal-cms/snapshot.ts";
import { drupalSnapshot } from "./drupal/snapshot.ts";
import { eleventySnapshot } from "./eleventy/snapshot.ts";
import { emptySnapshot } from "./empty/snapshot.ts";
import { fastapiSnapshot } from "./fastapi/snapshot.ts";
import { hugoSnapshot } from "./hugo/snapshot.ts";
import { jekyllSnapshot } from "./jekyll/snapshot.ts";
import { joomlaSnapshot } from "./joomla/snapshot.ts";
import { lampSnapshot } from "./lamp/snapshot.ts";
import { laravelSnapshot } from "./laravel/snapshot.ts";
import { lempSnapshot } from "./lemp/snapshot.ts";
import { meanSnapshot } from "./mean/snapshot.ts";
import { nextjsSnapshot } from "./nextjs/snapshot.ts";
import { nodeApiSnapshot } from "./node-api/snapshot.ts";
import { nodePostgresSnapshot } from "./node-postgres/snapshot.ts";
import { nodeTsSnapshot } from "./node-ts/snapshot.ts";
import { railsSnapshot } from "./rails/snapshot.ts";
import { sveltekitSnapshot } from "./sveltekit/snapshot.ts";
import { symfonySnapshot } from "./symfony/snapshot.ts";
import { toolboxSnapshot } from "./toolbox/snapshot.ts";
import { wordpressSnapshot } from "./wordpress/snapshot.ts";

const SNAPSHOTS: ReadonlyArray<readonly [string, RecipeSnapshot]> = [
  ["lamp", lampSnapshot],
  ["lemp", lempSnapshot],
  ["wordpress", wordpressSnapshot],
  ["laravel", laravelSnapshot],
  ["symfony", symfonySnapshot],
  ["drupal", drupalSnapshot],
  ["drupal-cms", drupalCmsSnapshot],
  ["backdrop", backdropSnapshot],
  ["joomla", joomlaSnapshot],
  ["node-postgres", nodePostgresSnapshot],
  ["node-api", nodeApiSnapshot],
  ["mean", meanSnapshot],
  ["node-ts", nodeTsSnapshot],
  ["astro", astroSnapshot],
  ["sveltekit", sveltekitSnapshot],
  ["nextjs", nextjsSnapshot],
  ["django", djangoSnapshot],
  ["fastapi", fastapiSnapshot],
  ["rails", railsSnapshot],
  ["jekyll", jekyllSnapshot],
  ["hugo", hugoSnapshot],
  ["eleventy", eleventySnapshot],
  ["empty", emptySnapshot],
  ["toolbox", toolboxSnapshot],
];

export const BUILTIN_RECIPE_SNAPSHOTS: ReadonlyMap<string, RecipeSnapshot> = new Map(SNAPSHOTS);

export const lookupRecipeSnapshot = (recipeId: string): RecipeSnapshot | undefined =>
  BUILTIN_RECIPE_SNAPSHOTS.get(recipeId);

/** Bundled recipe ids that publish a declarative snapshot, in declaration order. */
export const builtinRecipeSnapshotIds = (): ReadonlyArray<string> => SNAPSHOTS.map(([id]) => id);
