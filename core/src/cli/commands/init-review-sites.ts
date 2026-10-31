import { readProxyDefaultDomain } from "@lando/engine/config/proxy-default-domain";
import { normalizeAppSlug } from "@lando/engine/planner/naming";
import {
  type ExpressionContext,
  evaluateTemplateEither,
  expressionTouchesOnlyScopes,
} from "@lando/sdk/expressions";
import { isPlainRecord } from "@lando/sdk/landofile";
import { SNAPSHOT_RENDER_BUDGET } from "@lando/sdk/recipes";
import { AuthoringExpression, type GlobalConfig } from "@lando/sdk/schema";
import { Result, Schema } from "effect";
import type { RecipeInitReview } from "../../recipes/prepared-init";

export type InitReviewConfig = Pick<GlobalConfig, "proxy" | "router">;
export const UNRESOLVED_REVIEW_SITE = Symbol("unresolved-review-site");
export const INIT_REVIEW_LIMIT = 64;

/** Evaluate only existing authored sites; strings produced by options stay inert. */
export const reviewSites = (review: RecipeInitReview, config: InitReviewConfig | undefined) => {
  const slug = normalizeAppSlug(review.appName, review.appRoot);
  const recipe = "recipe" in review.source ? review.source.recipe : undefined;
  const context: ExpressionContext = {
    app: { name: slug, slug },
    ...(config === undefined ? {} : { proxy: { defaultDomain: readProxyDefaultDomain(config) } }),
    ...(isPlainRecord(recipe) && "options" in recipe && isPlainRecord(recipe.options)
      ? { recipe: recipe.options }
      : {}),
  };
  let remaining = INIT_REVIEW_LIMIT * 8;
  const value = (input: unknown): unknown => {
    if (!Schema.is(AuthoringExpression)(input)) return input;
    if (--remaining < 0 || !expressionTouchesOnlyScopes(input.template, ["app", "recipe", "proxy"]))
      return UNRESOLVED_REVIEW_SITE;
    const evaluated = evaluateTemplateEither(input.template, context, { budget: SNAPSHOT_RENDER_BUDGET });
    return Result.isSuccess(evaluated) ? evaluated.success : UNRESOLVED_REVIEW_SITE;
  };
  // Shallow allowlisted site projection, never a recursive document interpreter.
  const fields = (input: unknown, keys: readonly string[]): unknown => {
    const record = value(input);
    if (!isPlainRecord(record)) return record;
    const projected = Object.fromEntries(
      keys.filter((key) => Object.hasOwn(record, key)).map((key) => [key, value(record[key])]),
    );
    return Object.values(projected).includes(UNRESOLVED_REVIEW_SITE) ? UNRESOLVED_REVIEW_SITE : projected;
  };
  return { value, fields };
};
