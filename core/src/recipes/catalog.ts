import { BUNDLED_RECIPE_CATALOG } from "./generated/catalog.ts";

export interface RecipeCatalogEntry {
  readonly id: string;
  readonly title: string;
  readonly description: string;
}

export const getRecipeCatalog = (): readonly RecipeCatalogEntry[] => BUNDLED_RECIPE_CATALOG;
