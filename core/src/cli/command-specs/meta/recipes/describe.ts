import { Effect } from "effect";
import { Args, Flags } from "../../../spec/metadata";

import { NotImplementedError } from "@lando/sdk/errors";

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
  topLevelAlias: "recipes:describe",
  aliases: ["recipes:describe"],
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
  run: (input) => {
    const ref = recipeRefFromInput(input);
    if (ref === "") {
      return Effect.fail(
        new NotImplementedError({
          message: "recipes:describe requires a recipe ref.",
          commandId: "meta:recipes:describe",
          remediation: "Example: lando recipes:describe lamp",
        }),
      );
    }
    return recipesDescribe(ref, { cwd: process.cwd() });
  },
  render: (result) => renderRecipesDescribeResult(result as RecipesDescribeResult),
};
