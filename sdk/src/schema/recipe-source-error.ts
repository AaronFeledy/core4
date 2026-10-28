import { Schema } from "effect";

// ==== Pure compilation diagnostics contain coordinates, never input values
export class RecipeSourceCompileError extends Schema.TaggedError<RecipeSourceCompileError>()(
  "RecipeSourceCompileError",
  {
    recipeId: Schema.String,
    path: Schema.String,
    reason: Schema.Literals([
      "source-invalid",
      "config-invalid",
      "condition-invalid",
      "option-default",
      "option-descriptor",
      "secret-invalid",
      "asset-invalid",
      "variant-budget",
      "template-invalid",
    ]),
    message: Schema.String,
    remediation: Schema.String,
  },
) {}

export const recipeSourceFailure = (
  recipeId: string,
  reason: RecipeSourceCompileError["reason"],
  path: string,
) =>
  new RecipeSourceCompileError({
    recipeId,
    reason,
    path,
    message: `Recipe source compilation failed (${reason}).`,
    remediation:
      "Correct the indicated source declaration using supported typed options, authored config and pure conditions.",
  });
