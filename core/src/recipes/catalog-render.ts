export type RecipeCatalogDisplayEntry = {
  readonly id: string;
  readonly title: string;
};

export const renderRecipeCatalog = (recipes: readonly RecipeCatalogDisplayEntry[]): string => {
  if (recipes.length === 0) return "No bundled recipes.";
  const width = Math.max(...recipes.map((entry) => entry.id.length));
  const lines = recipes.map((entry) => `${entry.id.padEnd(width)}  ${entry.title}`);
  return [`Bundled recipes (${recipes.length}):`, ...lines].join("\n");
};
