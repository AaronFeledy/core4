import {
  type EvaluationBudget,
  type ExpressionContext,
  evaluateTemplateEither,
  expressionInterpolationsTouchOnlyScopes,
  parseExpressionEither,
} from "@lando/sdk/expressions";
import { Predicate, Result } from "effect";

import type { ValidationIssuePath } from "@lando/sdk/schema";

/**
 * Expression scopes the planner can resolve before any service type runs.
 *
 * `app` and `proxy` need the app identity and the proxy domain; `recipe` and
 * `env` are resolvable from the merged file and the host. None of them depend
 * on another service, so the planner materializes them in one pass over the
 * whole document before service resolution.
 */
export const PLAN_IDENTITY_EXPRESSION_SCOPES: ReadonlyArray<string> = ["app", "proxy", "recipe", "env"];

/**
 * Expression scopes the planner resolves only after every service type has
 * run: `services.<name>.creds.*` reads credentials a service type publishes
 * during resolution, so a site that touches it (alone or mixed with the
 * identity scopes) waits for that second pass.
 */
export const PLAN_SERVICE_EXPRESSION_SCOPES: ReadonlyArray<string> = [
  ...PLAN_IDENTITY_EXPRESSION_SCOPES,
  "services",
];

/**
 * Expression scopes a loaded Landofile may still carry after the load walk.
 *
 * `app`, `proxy`, and `services` stay unevaluated until the planner knows the
 * app identity, the proxy domain, and the resolved service credentials.
 * `recipe` and `env` are resolvable from the file and the host, but only once
 * every layer has merged, so the load walk defers them too and
 * {@link materializeLoadScopeExpressions} resolves them against the merged
 * document.
 */
export const LOAD_DEFERRED_EXPRESSION_SCOPES: ReadonlyArray<string> = PLAN_SERVICE_EXPRESSION_SCOPES;

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

/** A value site that could not be resolved from the merged document. */
export interface UnresolvedLoadScopeExpression {
  /** Location of the value site holding the expression. */
  readonly path: ValidationIssuePath;
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
export const recipeOptionScope = (
  merged: Record<string, unknown>,
): Readonly<Record<string, unknown>> | undefined => {
  const recipe = merged.recipe;
  if (!Predicate.isObject(recipe)) return undefined;
  const options = (recipe as { readonly options?: unknown }).options;
  if (!Predicate.isObject(options)) return undefined;
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
  const materialized = materializeExpressionScopes(merged, filePath, {
    context: { env, recipe: options },
    scopes: LOAD_RESOLVABLE_EXPRESSION_SCOPES,
    unavailableScopes: options === undefined ? ["recipe"] : [],
  });
  return {
    value: materialized.value,
    unresolved: materialized.unresolved.map(({ path, expression, reason }) => {
      const parsed = parseExpressionEither(expression, { filePath, bareShellParameters: "preserve" });
      const needsOptions =
        Result.isSuccess(parsed) && !expressionInterpolationsTouchOnlyScopes(parsed.success, ["env"]);
      return {
        path,
        reason: reason.startsWith("Expression budget exceeded")
          ? "it exceeds the load-time expression budget"
          : needsOptions
            ? options === undefined
              ? "the Landofile records no recipe options"
              : "it references a recipe option the Landofile does not set"
            : "it references an environment variable that is not set and declares no default",
      };
    }),
  };
};

export const materializeExpressionScopes = <T extends object>(
  merged: T,
  filePath: string,
  input: {
    readonly context: ExpressionContext;
    readonly scopes: ReadonlyArray<string>;
    readonly budget?: EvaluationBudget;
    readonly unavailableScopes?: ReadonlyArray<string>;
    /**
     * Restricts the walk to the string sites this predicate accepts. A later
     * pass over a document an earlier pass already rewrote hands in the sites
     * that pass deferred, so a value the earlier pass PRODUCED is never read
     * as an expression.
     */
    readonly eligible?: (value: string, path: ReadonlyArray<string | number>) => boolean;
  },
): {
  readonly value: T;
  readonly unresolved: ReadonlyArray<UnresolvedLoadScopeExpression & { readonly expression: string }>;
  /** Sites left untouched because an interpolation reads a scope outside `scopes`. */
  readonly deferred: ReadonlyArray<{ readonly path: ValidationIssuePath; readonly expression: string }>;
} => {
  const unresolved: Array<UnresolvedLoadScopeExpression & { readonly expression: string }> = [];
  const deferred: Array<{ readonly path: ValidationIssuePath; readonly expression: string }> = [];

  const visit = (value: unknown, path: ReadonlyArray<string | number>): unknown => {
    if (typeof value === "string") {
      if (!value.includes("{{") || input.eligible?.(value, path) === false) return value;
      const parsed = parseExpressionEither(value, { filePath, bareShellParameters: "preserve" });
      if (Result.isFailure(parsed)) return value;
      if (sourceHasUnescapedBracedForm(value)) return value;
      if (!expressionInterpolationsTouchOnlyScopes(parsed.success, input.scopes)) {
        deferred.push({ path, expression: value });
        return value;
      }
      const availableScopes = input.scopes.filter((scope) => !input.unavailableScopes?.includes(scope));
      if (!expressionInterpolationsTouchOnlyScopes(parsed.success, availableScopes)) {
        unresolved.push({ path, expression: value, reason: "The expression scope is unavailable." });
        return value;
      }
      const evaluated = evaluateTemplateEither(parsed.success, input.context, {
        filePath,
        budget: input.budget ?? LOAD_EXPRESSION_BUDGET,
      });
      if (Result.isFailure(evaluated)) {
        unresolved.push({ path, expression: value, reason: evaluated.failure.message });
        return value;
      }
      return evaluated.success;
    }
    if (Array.isArray(value)) {
      const visited = value.map((entry, index) => visit(entry, [...path, index]));
      return visited.every((entry, index) => entry === value[index]) ? value : visited;
    }
    if (Predicate.isObjectOrArray(value)) {
      let changed = false;
      const entries = Object.entries(value as Record<string, unknown>).map(([key, entry]) => {
        const visited = path.length === 0 && key === "recipe" ? entry : visit(entry, [...path, key]);
        if (visited !== entry) changed = true;
        return [key, visited];
      });
      return changed ? Object.fromEntries(entries) : value;
    }
    return value;
  };

  // Provenance is inert data the user reads; never rewrite it.
  return {
    value: visit(merged, []) as T,
    unresolved,
    deferred,
  };
};
