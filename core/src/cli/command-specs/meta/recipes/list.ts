import {
  type RecipesListResult,
  RecipesListResultSchema,
  recipesList,
  renderRecipesListResult,
} from "../../../commands/recipes";
import type { LandoCommandSpec } from "../../../spec/command-base";

export const metaRecipesListSpec: LandoCommandSpec<RecipesListResult> = {
  resultSchema: RecipesListResultSchema,
  id: "meta:recipes:list",
  rendersTable: true,
  mcpAllowed: true,
  summary: "List canonical recipes shipped with the binary.",
  namespace: "meta",
  topLevelAlias: ["recipes:list", "recipes"],
  aliases: ["recipes:list", "recipes"],
  bootstrap: "none",
  run: () => recipesList,
  render: (result) => renderRecipesListResult(result),
};
