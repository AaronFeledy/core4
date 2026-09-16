import { Either } from "effect";
import { RecipeSnapshotError } from "../errors/recipe.ts";
import type { ExpressionNode, PathSegment } from "../expressions/ast.ts";
import { evaluateExpressionEither } from "../expressions/evaluator.ts";
import type { RecipeOptionValue } from "../schema/recipe-identity.ts";
import type { RecipeSnapshot, RecipeSnapshotTemplate } from "../schema/recipe-snapshot.ts";

/** Closed set of deterministic data helpers allowed in serialized snapshots. */
export const SNAPSHOT_HELPER_ALLOWLIST: ReadonlySet<string> = new Set([
  "default",
  "required",
  "eq",
  "ne",
  "lt",
  "gt",
  "le",
  "ge",
  "and",
  "or",
  "not",
  "contains",
  "startsWith",
  "endsWith",
  "lower",
  "upper",
  "trim",
  "split",
  "join",
  "replace",
  "regexMatch",
  "length",
  "slice",
  "keys",
  "values",
  "entries",
  "get",
  "merge",
  "range",
  "map",
  "filter",
  "json",
  "fromJson",
  "b64encode",
  "b64decode",
  "shellQuote",
  "shellJoin",
  "path.join",
  "path.dirname",
  "path.basename",
  "path.extname",
  "path.relative",
  "path.resolve",
  "url.build",
  "url.parse",
  "semver.satisfies",
  "semver.compare",
]);

/** Per-render ceilings; root expression depth is one and byte counts are UTF-8. */
export const SNAPSHOT_RENDER_BUDGET = Object.freeze({
  maxSteps: 100_000,
  maxDepth: 32,
  maxOutputBytes: 1_048_576,
  maxCollectionSize: 10_000,
});

type Violation = {
  readonly path: string;
  readonly reason: "template-scope" | "helper-forbidden" | "depth-exceeded";
};

/**
 * Inspect all expression variants, including dynamic path keys and dead branches.
 * Traversal stops at an over-depth subtree, preventing recursive stack exhaustion.
 * Paths name locations in the serialized template rather than rendered output.
 */
export const collectSnapshotTemplateViolations = (node: ExpressionNode): ReadonlyArray<Violation> => {
  const violations: Violation[] = [];
  const segments = (items: ReadonlyArray<PathSegment>, path: string, depth: number): void => {
    items.forEach((segment, index) => {
      switch (segment.type) {
        case "prop":
        case "index":
        case "key":
          return;
        case "dynamic":
          visit(segment.expr, `${path}.segments[${index}].expr`, depth + 1);
          return;
        default:
          return segment satisfies never;
      }
    });
  };
  const visit = (current: ExpressionNode, path: string, depth: number): void => {
    if (depth > SNAPSHOT_RENDER_BUDGET.maxDepth) {
      violations.push({ path, reason: "depth-exceeded" });
      return;
    }
    switch (current.kind) {
      case "Literal":
        return;
      case "ArrayLiteral":
        current.elements.forEach((child, i) => visit(child, `${path}.elements[${i}]`, depth + 1));
        return;
      case "ObjectLiteral":
        current.entries.forEach((entry, i) => visit(entry.value, `${path}.entries[${i}].value`, depth + 1));
        return;
      case "Path":
        if (current.head !== "options") violations.push({ path: `${path}.head`, reason: "template-scope" });
        segments(current.segments, path, depth);
        return;
      case "Access":
        visit(current.target, `${path}.target`, depth + 1);
        segments(current.segments, path, depth);
        return;
      case "Call":
        if (!SNAPSHOT_HELPER_ALLOWLIST.has(current.callee))
          violations.push({ path: `${path}.callee`, reason: "helper-forbidden" });
        current.args.forEach((child, i) => visit(child, `${path}.args[${i}]`, depth + 1));
        return;
      case "Conditional":
        visit(current.test, `${path}.test`, depth + 1);
        visit(current.consequent, `${path}.consequent`, depth + 1);
        visit(current.alternate, `${path}.alternate`, depth + 1);
        return;
      default:
        current satisfies never;
        return;
    }
  };
  visit(node, "expression", 1);
  return violations;
};

/** Return the first structural template violation as a tagged, value-free error. */
export const validateSnapshotTemplate = (
  recipeId: string,
  template: RecipeSnapshotTemplate,
): Either.Either<RecipeSnapshotTemplate, RecipeSnapshotError> => {
  const violation = collectSnapshotTemplateViolations(template.expression)[0];
  return violation === undefined
    ? Either.right(template)
    : Either.left(
        new RecipeSnapshotError({
          recipeId,
          ...violation,
          message: `Invalid snapshot template (${violation.reason}).`,
          remediation: "Use only the options scope and approved helpers within the template depth limit.",
        }),
      );
};

// Bound input data before evaluation as well as bounding intermediate evaluator
// values. Iteration keeps hostile collection sizes from consuming the call stack.
const withinInputBudget = (value: unknown): boolean => {
  const pending = [value];
  const seen = new Set<object>();
  let steps = 0;
  let bytes = 0;
  const encoder = new TextEncoder();
  while (pending.length > 0) {
    const current = pending.pop();
    if (++steps > SNAPSHOT_RENDER_BUDGET.maxSteps) return false;
    if (typeof current === "string") bytes += encoder.encode(current).length;
    if (bytes > SNAPSHOT_RENDER_BUDGET.maxOutputBytes) return false;
    if (current !== null && typeof current === "object") {
      if (seen.has(current)) return false;
      seen.add(current);
      const entries = Object.entries(current);
      if (entries.length > SNAPSHOT_RENDER_BUDGET.maxCollectionSize) return false;
      for (const [key, child] of entries) {
        bytes += encoder.encode(key).length;
        pending.push(child);
      }
    }
  }
  return bytes <= SNAPSHOT_RENDER_BUDGET.maxOutputBytes;
};

/**
 * Render once using defaults underneath supplied nonsecret options. No ambient
 * scopes, IO helpers, or second interpolation pass are available: expression-like
 * strings in the result remain ordinary data. Input and evaluator budgets apply
 * independently; failure diagnostics never embed rendered values.
 */
export const renderRecipeSnapshot = (
  snapshot: RecipeSnapshot,
  options: Record<string, RecipeOptionValue>,
): Either.Either<unknown, RecipeSnapshotError> => {
  const recipeId = snapshot.identity.recipeId;
  const fail = (reason: "budget-exceeded" | "render-output-invalid") =>
    new RecipeSnapshotError({
      recipeId,
      reason,
      message: `Snapshot rendering failed (${reason}).`,
      remediation: "Correct the snapshot expression or reduce its input and output sizes.",
    });
  const validation = validateSnapshotTemplate(recipeId, snapshot.template);
  if (Either.isLeft(validation)) return validation;
  const merged = { ...snapshot.defaults, ...options };
  if (!withinInputBudget(snapshot.template) || !withinInputBudget(merged))
    return Either.left(fail("budget-exceeded"));
  return evaluateExpressionEither(
    snapshot.template.expression,
    { options: merged },
    { budget: SNAPSHOT_RENDER_BUDGET },
  ).pipe(
    Either.mapLeft((error) =>
      fail(/budget/i.test(error.message) ? "budget-exceeded" : "render-output-invalid"),
    ),
  );
};
