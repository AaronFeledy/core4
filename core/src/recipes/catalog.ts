/**
 * Catalog metadata for the bundled built-in recipes.
 */
import { BUNDLED_RECIPES } from "./bundled.ts";

export interface RecipeCatalogEntry {
  readonly id: string;
  readonly title: string;
  readonly description: string;
}

const TOP_LEVEL_STRING_RE = (field: string) => new RegExp(`^${field}:[ \\t]+(.+?)[ \\t]*$`, "m");

const extractTopLevelScalar = (yaml: string, field: string): string | undefined => {
  const match = TOP_LEVEL_STRING_RE(field).exec(yaml);
  if (match === null) return undefined;
  const raw = match[1] ?? "";
  // Strip surrounding single or double quotes if present.
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  return raw;
};

let cachedCatalog: ReadonlyArray<RecipeCatalogEntry> | undefined;

/**
 * Returns the bundled recipe catalog in manifest order.
 */
export const getRecipeCatalog = (): ReadonlyArray<RecipeCatalogEntry> => {
  if (cachedCatalog !== undefined) return cachedCatalog;
  const entries = BUNDLED_RECIPES.map((recipe) => ({
    id: recipe.id,
    title: extractTopLevelScalar(recipe.manifestYaml, "title") ?? recipe.id,
    description: extractTopLevelScalar(recipe.manifestYaml, "description") ?? "",
  }));
  cachedCatalog = entries;
  return entries;
};
