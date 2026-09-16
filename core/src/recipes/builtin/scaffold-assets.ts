import type { RecipeAuxiliaryContentSource } from "../init-pipeline/files.ts";
import { MEAN_PACKAGE_JSON_TEMPLATE, MEAN_SERVER_JS } from "./mean/scaffold.ts";
import { NODE_POSTGRES_PACKAGE_JSON_TEMPLATE, NODE_POSTGRES_SERVER_JS } from "./node-postgres/scaffold.ts";
import { RAILS_GEMFILE } from "./rails/scaffold.ts";

/**
 * Auxiliary scaffold bytes the bundled recipes carry in memory, keyed by recipe
 * id and then by manifest destination.
 *
 * The manifest `src` of a bundled entry is a label, not a path, so destination
 * is the only stable key. These are the unrendered source bytes: the digests
 * published in each recipe snapshot hash exactly these values.
 */
const BUNDLED_SCAFFOLD_ASSETS: ReadonlyMap<string, ReadonlyMap<string, string>> = new Map([
  [
    "mean",
    new Map([
      ["package.json", MEAN_PACKAGE_JSON_TEMPLATE],
      ["server.js", MEAN_SERVER_JS],
    ]),
  ],
  [
    "node-postgres",
    new Map([
      ["package.json", NODE_POSTGRES_PACKAGE_JSON_TEMPLATE],
      ["server.js", NODE_POSTGRES_SERVER_JS],
    ]),
  ],
  ["rails", new Map([["Gemfile", RAILS_GEMFILE]])],
]);

/** A content source over the bundled assets of one recipe. */
export const bundledRecipeContentSource =
  (recipeId: string): RecipeAuxiliaryContentSource =>
  (file) =>
    Promise.resolve(BUNDLED_SCAFFOLD_ASSETS.get(recipeId)?.get(file.dest));
