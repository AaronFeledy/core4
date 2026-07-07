import { Args, Flags } from "@oclif/core";

import {
  type RecipesDescribeResult,
  RecipesDescribeResultSchema,
  recipeRefFromInput,
  recipesDescribe,
  renderRecipesDescribeResult,
} from "../../../../commands/recipes.ts";
import { LandoCommandBase, type LandoCommandSpec } from "../../../command-base.ts";

export const metaRecipesDescribeSpec: LandoCommandSpec<RecipesDescribeResult> = {
  resultSchema: RecipesDescribeResultSchema,
  id: "meta:recipes:describe",
  mcpAllowed: true,
  summary: "Print a recipe's prompts and metadata without running it.",
  namespace: "meta",
  bootstrap: "minimal",
  run: (input) => recipesDescribe(recipeRefFromInput(input), { cwd: process.cwd() }),
  render: (result) => renderRecipesDescribeResult(result as RecipesDescribeResult),
};

export default class MetaRecipesDescribeCommand extends LandoCommandBase {
  static override description = metaRecipesDescribeSpec.summary;
  static override args = {
    ref: Args.string({ description: "Recipe ref: a bundled recipe id or a local path.", required: true }),
  };
  static override flags = {
    format: Flags.string({
      description: "Output format.",
      options: ["table", "json"],
      default: "table",
    }),
  };
  static override landoSpec: LandoCommandSpec = metaRecipesDescribeSpec;
  static override bootstrap = metaRecipesDescribeSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(metaRecipesDescribeSpec);
  }
}
