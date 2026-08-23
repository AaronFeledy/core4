import { Flags } from "../../../spec/metadata";

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
  mcpAllowed: true,
  summary: "List canonical recipes shipped with the binary.",
  namespace: "meta",
  topLevelAlias: ["recipes:list", "recipes"],
  aliases: ["recipes:list", "recipes"],
  bootstrap: "none",
  flags: {
    format: Flags.string({
      description: "Output format.",
      options: ["table", "json"],
      default: "table",
    }),
  },
  run: () => recipesList,
  render: (result) => renderRecipesListResult(result as RecipesListResult),
};
