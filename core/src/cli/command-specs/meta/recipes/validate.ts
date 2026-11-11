import { NotImplementedError } from "@lando/sdk/errors";
import { Effect } from "effect";
import { CliInvocation } from "../../../../runtime/invocation-context";
import {
  type RecipesValidateResult,
  RecipesValidateResultSchema,
  recipePathFromInput,
  recipesValidate,
  renderRecipesValidateResult,
} from "../../../commands/recipes";
import type { LandoCommandSpec } from "../../../spec/command-base";
import { Args } from "../../../spec/metadata";

export const metaRecipesValidateSpec: LandoCommandSpec<RecipesValidateResult> = {
  resultSchema: RecipesValidateResultSchema,
  id: "meta:recipes:validate",
  onlineAcquisition: true,
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
  run: (input) => {
    const path = recipePathFromInput(input);
    if (path === "") {
      return Effect.fail(
        new NotImplementedError({
          message: "recipes:validate requires a recipe path.",
          commandId: "meta:recipes:validate",
          remediation: "Example: lando recipes:validate ./",
        }),
      );
    }
    return Effect.flatMap(CliInvocation, ({ cwd }) => recipesValidate(path, { cwd }));
  },
  render: (result) => renderRecipesValidateResult(result),
};
