import { isPlainRecord } from "@lando/sdk/landofile";
import type { ParsedPendingSite } from "@lando/sdk/schema";

export const PLAN_IDENTITY_EXPRESSION_SCOPES: readonly string[] = ["app", "proxy", "recipe", "env"];
export const PLAN_SERVICE_EXPRESSION_SCOPES: readonly string[] = [
  ...PLAN_IDENTITY_EXPRESSION_SCOPES,
  "services",
];
export const LOAD_DEFERRED_EXPRESSION_SCOPES = PLAN_SERVICE_EXPRESSION_SCOPES;
export const LOAD_RESOLVABLE_EXPRESSION_SCOPES: readonly string[] = ["recipe", "env"];

export interface LandofileLoadScope {
  readonly pendingSites?: ParsedPendingSite[];
  readonly env: Readonly<Record<string, string>>;
  readonly recipe: Readonly<Record<string, unknown>> | undefined;
}

export const hostExpressionEnvironment = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).flatMap(([key, value]) => (typeof value === "string" ? [[key, value]] : [])),
  );

export const recipeOptionScope = (
  document: Record<string, unknown>,
): Readonly<Record<string, unknown>> | undefined => {
  const recipe = document.recipe;
  return isPlainRecord(recipe) && isPlainRecord(recipe.options) ? recipe.options : undefined;
};
