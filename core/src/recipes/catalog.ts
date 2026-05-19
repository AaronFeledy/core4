/**
 * Catalog metadata for the bundled built-in recipes.
 *
 * Used by the interactive `lando init` flow to render the recipe
 * picker when `--recipe` is omitted (§8.8.1). Metadata is extracted
 * lazily from the static `manifestYaml` strings of `BUNDLED_RECIPES`
 * by matching top-level scalar fields (`title:`, `description:`); no
 * full YAML parse is required and no runtime FS access is needed in
 * the compiled `$bunfs` binary.
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
  // Strip surrounding single or double quotes if present (round-trip safe;
  // bundled manifests never embed escape sequences in title/description).
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  return raw;
};

let cachedCatalog: ReadonlyArray<RecipeCatalogEntry> | undefined;

/**
 * Returns the ordered catalog of bundled recipes with `id`, `title`,
 * and `description` extracted from each manifest YAML. Order matches
 * `BUNDLED_RECIPES`.
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
