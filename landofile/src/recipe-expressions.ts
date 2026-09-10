import {
  type EvaluationBudget,
  type ExpressionTemplate,
  evaluateTemplateEither,
  expressionInterpolationsTouchOnlyScopes,
  parseExpressionEither,
} from "@lando/sdk/expressions";
import { Either } from "effect";

/**
 * Expression scopes a loaded Landofile may still carry after the load walk.
 *
 * `app` and `proxy` stay unevaluated until the planner knows the app identity
 * and proxy domain. `recipe` and `env` are resolvable from the file and the
 * host, but only once every layer has merged, so the load walk defers them too
 * and {@link materializeLoadScopeExpressions} resolves them against the merged
 * document.
 */
export const LOAD_DEFERRED_EXPRESSION_SCOPES: ReadonlyArray<string> = ["app", "proxy", "recipe", "env"];

/**
 * The subset of the deferred scopes the loader itself can resolve. Everything
 * else in {@link LOAD_DEFERRED_EXPRESSION_SCOPES} belongs to the planner.
 */
export const LOAD_RESOLVABLE_EXPRESSION_SCOPES: ReadonlyArray<string> = ["recipe", "env"];

/**
 * Caps one load-time recipe/env evaluation so a hostile or typo'd helper cannot
 * allocate without bound before schema validation. Bundled snapshot sites are
 * scalar `default()` / path reads; this is far above that and far below a hang.
 */
const LOAD_EXPRESSION_BUDGET: EvaluationBudget = {
  maxSteps: 1024,
  maxDepth: 32,
  maxOutputBytes: 65536,
  maxCollectionSize: 256,
};

/**
 * True when the source contains an unescaped `${...}` form.
 *
 * The parser treats `$${` as a literal `${` escape. A parsed segment cannot
 * tell `${VAR}` from `$VAR`, so the load path asks the raw source. Matching
 * the substring `${` is not enough: it also matches that escape.
 */
export const sourceHasUnescapedBracedForm = (source: string): boolean => {
  let index = source.indexOf("${");
  while (index !== -1) {
    if (index === 0 || source[index - 1] !== "$") return true;
    index = source.indexOf("${", index + 2);
  }
  return false;
};

/**
 * True when a value site's expressions may resolve from loader-owned data.
 *
 * The raw source decides the braced question, not the AST: a parsed segment
 * cannot tell `${VAR}` from `$VAR`, and only the bare spelling is inert here.
 * Unescaped `${...}` parameter and `${secret:...}` references stay unsupported
 * on the load path - including on the files whose raw pre-parse scan is skipped
 * - so a site carrying one is left for the strict path to reject.
 */
const resolvableAtLoad = (source: string, template: ExpressionTemplate): boolean =>
  !sourceHasUnescapedBracedForm(source) &&
  expressionInterpolationsTouchOnlyScopes(template, LOAD_RESOLVABLE_EXPRESSION_SCOPES);

/**
 * Replays bare shell-parameter text as a literal segment.
 *
 * The evaluator resolves `$name` from the `env` scope. That text is not the
 * loader's: a Landofile value carrying `$name` and no expression is returned
 * byte-for-byte today, and the string usually goes on to a container shell that
 * owns those names. So the loader resolves the `{{ ... }}` interpolations around
 * the text and leaves the text itself exactly as authored.
 *
 * Only `$` immediately followed by an identifier start becomes a segment, so
 * `$$`, `$1` and `$(cmd)` are already literal text and need no replay. Only the
 * bare spelling is rewritten because {@link resolvableAtLoad} refuses unescaped
 * `${`, which every operator spelling requires.
 */
const withInertShellText = (template: ExpressionTemplate): ExpressionTemplate => ({
  whole: template.whole,
  segments: template.segments.map((segment) =>
    segment.kind === "ShellParamSegment" && segment.operator === "plain"
      ? ({ kind: "LiteralSegment", text: `$${segment.name}` } as const)
      : segment,
  ),
});

/** A value site that could not be resolved from the merged document. */
export interface UnresolvedLoadScopeExpression {
  /** Dotted path of the value site holding the expression. */
  readonly path: string;
  readonly reason: string;
}

export interface MaterializedLoadScopeExpressions {
  /** The document with every resolvable expression replaced by its value. */
  readonly value: Record<string, unknown>;
  /** Sites referencing data the merged document and host environment do not provide. */
  readonly unresolved: ReadonlyArray<UnresolvedLoadScopeExpression>;
}

/**
 * The host environment as the expression language sees it.
 *
 * `process.env` may hold undefined entries; the `env` scope is a plain string
 * map, so those are dropped rather than surfaced as empty values.
 */
export const hostExpressionEnvironment = (): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
};

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

/**
 * Resolves the load-owned expression scopes against the merged document and the
 * host environment.
 *
 * This performs no recipe lookup, loads no plugin, and runs no recipe code: the
 * only data it reads is the file the user owns plus the process environment.
 * A site that also references a planner-owned scope is left exactly as it is,
 * whole: resolving half of one string would strand the rest and would change
 * how the planner sees its own interpolation.
 */
export const materializeLoadScopeExpressions = (
  merged: Record<string, unknown>,
  filePath: string,
  env: Readonly<Record<string, string>>,
): MaterializedLoadScopeExpressions => {
  const options = recipeOptionScope(merged);
  const unresolved: UnresolvedLoadScopeExpression[] = [];

  const visit = (value: unknown, path: ReadonlyArray<string | number>): unknown => {
    if (typeof value === "string") {
      if (!value.includes("{{")) return value;
      const parsed = parseExpressionEither(value, { filePath });
      if (Either.isLeft(parsed)) return value;
      if (!resolvableAtLoad(value, parsed.right)) return value;
      const needsOptions = !expressionInterpolationsTouchOnlyScopes(parsed.right, ["env"]);
      if (needsOptions && options === undefined) {
        unresolved.push({ path: path.join("."), reason: "the Landofile records no recipe options" });
        return value;
      }
      const evaluated = evaluateTemplateEither(
        withInertShellText(parsed.right),
        options === undefined ? { env } : { env, recipe: options },
        { filePath, budget: LOAD_EXPRESSION_BUDGET },
      );
      if (Either.isLeft(evaluated)) {
        let reason: string;
        if (evaluated.left.message.startsWith("Expression budget exceeded")) {
          reason = "it exceeds the load-time expression budget";
        } else if (needsOptions) {
          reason = "it references a recipe option the Landofile does not set";
        } else {
          reason = "it references an environment variable that is not set and declares no default";
        }
        unresolved.push({ path: path.join("."), reason });
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
