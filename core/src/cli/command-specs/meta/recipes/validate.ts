import { Args, Flags } from "../../../spec/metadata";

import {
  type RecipesValidateResult,
  RecipesValidateResultSchema,
  recipePathFromInput,
  recipesValidate,
  renderRecipesValidateResult,
} from "../../../commands/recipes";
import type { LandoCommandSpec } from "../../../spec/command-base";

export const metaRecipesValidateSpec: LandoCommandSpec<RecipesValidateResult> = {
  resultSchema: RecipesValidateResultSchema,
  id: "meta:recipes:validate",
  mcpAllowed: true,
  summary: "Validate a recipe.yml against the published schema.",
  namespace: "meta",
  topLevelAlias: "recipes:validate",
  aliases: ["recipes:validate"],
  bootstrap: "minimal",
  args: {
    path: Args.string({
      description: "Path to a recipe.yml or a recipe directory.",
      required: true,
    }),
  },
  flags: {
    format: Flags.string({
      description: "Output format.",
      options: ["table", "json"],
      default: "table",
    }),
  },
  run: (input) => recipesValidate(recipePathFromInput(input), { cwd: process.cwd() }),
  render: (result) => renderRecipesValidateResult(result as RecipesValidateResult),
};
