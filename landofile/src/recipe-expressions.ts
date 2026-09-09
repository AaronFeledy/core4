import {
  evaluateTemplateEither,
  expressionTouchesOnlyScopes,
  parseExpressionEither,
} from "@lando/sdk/expressions";
import { Either } from "effect";

/**
 * Expression scopes a loaded Landofile may still carry after the load walk.
 *
 * `app` and `proxy` stay unevaluated until the planner knows the app identity
 * and proxy domain. `recipe` is resolvable from the file itself, but only after
 * every layer has merged, so the load walk defers it too and
 * {@link materializeRecipeOptionExpressions} resolves it against the merged
 * document.
 */
export const LOAD_DEFERRED_EXPRESSION_SCOPES: ReadonlyArray<string> = ["app", "proxy", "recipe"];

/** A recipe option site that could not be resolved from the merged document. */
export interface UnresolvedRecipeOptionExpression {
  /** Dotted path of the value site holding the expression. */
  readonly path: string;
  /** Why the site could not be resolved. */
  readonly reason: string;
}

export interface MaterializedRecipeOptionExpressions {
  /** The document with every resolvable recipe option reference replaced by its value. */
  readonly value: Record<string, unknown>;
  /** Sites that reference recipe options the merged document does not provide. */
  readonly unresolved: ReadonlyArray<UnresolvedRecipeOptionExpression>;
}

/**
 * Reads the recipe option scope out of a merged Landofile.
 *
 * Only the object provenance form carries options. The bare string form records
 * an id and nothing else, so it yields no scope and every `recipe.<option>`
 * reference stays unresolved.
 */
const recipeOptionScope = (
  merged: Record<string, unknown>,
): Readonly<Record<string, unknown>> | undefined => {
  const recipe = merged.recipe;
  if (typeof recipe !== "object" || recipe === null || Array.isArray(recipe)) return undefined;
  const options = (recipe as { readonly options?: unknown }).options;
  if (typeof options !== "object" || options === null || Array.isArray(options)) return undefined;
  return options as Readonly<Record<string, unknown>>;
};

const touchesRecipeScope = (value: string): boolean => value.includes("recipe.");

/**
 * Resolves `{{ recipe.<option> }}` sites against the merged document's own
 * `recipe.options`.
 *
 * This performs no recipe lookup, loads no plugin, and runs no recipe code: the
 * only data it reads is already in the file the user owns. Sites referencing
 * any other scope are left exactly as they are, so the planner still owns
 * `app` and `proxy` resolution.
 */
export const materializeRecipeOptionExpressions = (
  merged: Record<string, unknown>,
  filePath: string,
): MaterializedRecipeOptionExpressions => {
  const scope = recipeOptionScope(merged);
  const unresolved: UnresolvedRecipeOptionExpression[] = [];

  const visit = (value: unknown, path: ReadonlyArray<string | number>): unknown => {
    if (typeof value === "string") {
      if (!value.includes("{{") || !touchesRecipeScope(value)) return value;
      const parsed = parseExpressionEither(value, { filePath });
      if (Either.isLeft(parsed)) return value;
      // A site mixing recipe with a planner-owned scope belongs to whoever
      // resolves that scope; resolving half of it here would strand the rest.
      if (!expressionTouchesOnlyScopes(parsed.right, ["recipe"])) return value;
      if (scope === undefined) {
        unresolved.push({
          path: path.join("."),
          reason: "the Landofile records no recipe options",
        });
        return value;
      }
      const evaluated = evaluateTemplateEither(parsed.right, { recipe: scope }, { filePath });
      if (Either.isLeft(evaluated)) {
        unresolved.push({ path: path.join("."), reason: "it references an option the recipe block omits" });
        return value;
      }
      return evaluated.right;
    }
    if (Array.isArray(value)) return value.map((entry, index) => visit(entry, [...path, index]));
    if (typeof value === "object" && value !== null) {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
          key,
          visit(entry, [...path, key]),
        ]),
      );
    }
    return value;
  };

  // Provenance is inert data the user reads; never rewrite it.
  const { recipe, ...rest } = merged;
  const visited = visit(rest, []) as Record<string, unknown>;
  return {
    value: recipe === undefined ? visited : { ...visited, recipe },
    unresolved,
  };
};
