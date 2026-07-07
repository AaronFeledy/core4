import { Args, Flags } from "@oclif/core";

import {
  type RecipesValidateResult,
  RecipesValidateResultSchema,
  recipePathFromInput,
  recipesValidate,
  renderRecipesValidateResult,
} from "../../../../commands/recipes.ts";
import { LandoCommandBase, type LandoCommandSpec } from "../../../command-base.ts";

export const metaRecipesValidateSpec: LandoCommandSpec<RecipesValidateResult> = {
  resultSchema: RecipesValidateResultSchema,
  id: "meta:recipes:validate",
  mcpAllowed: true,
  summary: "Validate a recipe.yml against the published schema.",
  namespace: "meta",
  bootstrap: "minimal",
  run: (input) => recipesValidate(recipePathFromInput(input), { cwd: process.cwd() }),
  render: (result) => renderRecipesValidateResult(result as RecipesValidateResult),
};

export default class MetaRecipesValidateCommand extends LandoCommandBase {
  static override description = metaRecipesValidateSpec.summary;
  static override args = {
    path: Args.string({
      description: "Path to a recipe.yml or a recipe directory.",
      required: true,
    }),
  };
  static override flags = {
    format: Flags.string({
      description: "Output format.",
      options: ["table", "json"],
      default: "table",
    }),
  };
  static override landoSpec: LandoCommandSpec = metaRecipesValidateSpec;
  static override bootstrap = metaRecipesValidateSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(metaRecipesValidateSpec);
  }
}
