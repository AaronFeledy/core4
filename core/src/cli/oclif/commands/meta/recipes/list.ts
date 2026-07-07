import { Flags } from "@oclif/core";

import {
  type RecipesListResult,
  RecipesListResultSchema,
  recipesList,
  renderRecipesListResult,
} from "../../../../commands/recipes.ts";
import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../../command-base.ts";

export const metaRecipesListSpec: LandoCommandSpec<RecipesListResult> = {
  resultSchema: RecipesListResultSchema,
  id: "meta:recipes:list",
  mcpAllowed: true,
  summary: "List canonical recipes shipped with the binary.",
  namespace: "meta",
  topLevelAlias: "recipes",
  bootstrap: "none",
  run: () => recipesList,
  render: (result) => renderRecipesListResult(result as RecipesListResult),
};

export default class MetaRecipesListCommand extends LandoCommandBase {
  static override description = metaRecipesListSpec.summary;
  static override aliases = [...resolveTopLevelAliases(metaRecipesListSpec)];
  static override flags = {
    format: Flags.string({
      description: "Output format.",
      options: ["table", "json"],
      default: "table",
    }),
  };
  static override landoSpec: LandoCommandSpec = metaRecipesListSpec;
  static override bootstrap = metaRecipesListSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(metaRecipesListSpec);
  }
}
