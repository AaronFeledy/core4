import type { RecipeSource } from "@lando/sdk/schema";
import { source as astro } from "./astro/source.ts";
import { source as backdrop } from "./backdrop/source.ts";
import { source as django } from "./django/source.ts";
import { source as drupalCms } from "./drupal-cms/source.ts";
import { source as drupal } from "./drupal/source.ts";
import { source as eleventy } from "./eleventy/source.ts";
import { source as empty } from "./empty/source.ts";
import { source as fastapi } from "./fastapi/source.ts";
import { source as hugo } from "./hugo/source.ts";
import { source as jekyll } from "./jekyll/source.ts";
import { source as joomla } from "./joomla/source.ts";
import { source as lamp } from "./lamp/source.ts";
import { source as laravel } from "./laravel/source.ts";
import { source as lemp } from "./lemp/source.ts";
import { source as mean } from "./mean/source.ts";
import { source as nextjs } from "./nextjs/source.ts";
import { source as nodeApi } from "./node-api/source.ts";
import { source as nodePostgres } from "./node-postgres/source.ts";
import { source as nodeTs } from "./node-ts/source.ts";
import { source as rails } from "./rails/source.ts";
import { source as sveltekit } from "./sveltekit/source.ts";
import { source as symfony } from "./symfony/source.ts";
import { source as toolbox } from "./toolbox/source.ts";
import { source as wordpress } from "./wordpress/source.ts";

export const BUNDLED_RECIPE_SOURCES: ReadonlyMap<string, RecipeSource> = new Map<string, RecipeSource>([
  ["node-postgres", nodePostgres],
  ["wordpress", wordpress],
  ["laravel", laravel],
  ["symfony", symfony],
  ["lamp", lamp],
  ["backdrop", backdrop],
  ["joomla", joomla],
  ["lemp", lemp],
  ["node-api", nodeApi],
  ["mean", mean],
  ["astro", astro],
  ["sveltekit", sveltekit],
  ["nextjs", nextjs],
  ["django", django],
  ["drupal", drupal],
  ["drupal-cms", drupalCms],
  ["fastapi", fastapi],
  ["rails", rails],
  ["jekyll", jekyll],
  ["hugo", hugo],
  ["eleventy", eleventy],
  ["empty", empty],
  ["node-ts", nodeTs],
  ["toolbox", toolbox],
]);
