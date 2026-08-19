import { Args, Flags } from "../../../spec/metadata";

import {
  type RecipesDescribeResult,
  RecipesDescribeResultSchema,
  recipeRefFromInput,
  recipesDescribe,
  renderRecipesDescribeResult,
} from "../../../commands/recipes";
import type { LandoCommandSpec } from "../../../spec/command-base";

export const metaRecipesDescribeSpec: LandoCommandSpec<RecipesDescribeResult> = {
  resultSchema: RecipesDescribeResultSchema,
  id: "meta:recipes:describe",
  mcpAllowed: true,
  summary: "Print a recipe's prompts and metadata without running it.",
  namespace: "meta",
  bootstrap: "minimal",
  args: {
    ref: Args.string({ description: "Recipe ref: a bundled recipe id or a local path.", required: true }),
  },
  flags: {
    format: Flags.string({
      description: "Output format.",
      options: ["table", "json"],
      default: "table",
    }),
  },
  run: (input) => recipesDescribe(recipeRefFromInput(input), { cwd: process.cwd() }),
  render: (result) => renderRecipesDescribeResult(result as RecipesDescribeResult),
};
