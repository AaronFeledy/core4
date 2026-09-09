import type { ExpressionNode, ExpressionSegment, ExpressionTemplate, PathSegment } from "./ast.ts";
import { PURE_EXPRESSION_HELPER_NAMES } from "./evaluator.ts";

const isTemplate = (ast: ExpressionTemplate | ExpressionNode): ast is ExpressionTemplate => "whole" in ast;

/**
 * What a parsed expression reads, split along the two axes that matter.
 *
 * `scopes` are context namespaces (`app`, `env`, `recipe`, ...) named by the
 * head of a path lookup. `callees` are helper names, which is a different
 * question: a helper may be pure (`default`) or may reach the host (`load`,
 * `which`). `analyzable` is false when a construct hides its dependencies from
 * static inspection, in which case the other two sets are incomplete.
 */
interface ExpressionDependencies {
  readonly scopes: ReadonlySet<string>;
  readonly callees: ReadonlySet<string>;
  readonly analyzable: boolean;
}

interface DependencyAccumulator {
  readonly scopes: Set<string>;
  readonly callees: Set<string>;
  analyzable: boolean;
}

const visitNode = (node: ExpressionNode, into: DependencyAccumulator): void => {
  switch (node.kind) {
    case "Literal":
      return;
    case "Path":
      into.scopes.add(node.head);
      for (const segment of node.segments) visitSegment(segment, into);
      return;
    case "Access":
      visitNode(node.target, into);
      for (const segment of node.segments) visitSegment(segment, into);
      return;
    case "ArrayLiteral":
      for (const element of node.elements) visitNode(element, into);
      return;
    case "ObjectLiteral":
      for (const entry of node.entries) visitNode(entry.value, into);
      return;
    case "Conditional":
      // Evaluation is lazy, but analysis unions every branch: otherwise the
      // dependency set would change with runtime values and could hide a
      // host-reaching helper in the branch that happens not to be taken.
      visitNode(node.test, into);
      visitNode(node.consequent, into);
      visitNode(node.alternate, into);
      return;
    case "Call": {
      into.callees.add(node.callee);
      for (const argument of node.args) visitNode(argument, into);
      if (node.callee === "map" || node.callee === "filter") {
        // These dispatch to the helper named by their second argument, so that
        // name is a callee too. A computed name cannot be read statically.
        const target = node.args[1];
        if (target?.kind === "Literal" && typeof target.value === "string") into.callees.add(target.value);
        else into.analyzable = false;
      }
      return;
    }
  }
};

const visitSegment = (segment: PathSegment, into: DependencyAccumulator): void => {
  if (segment.type === "dynamic") visitNode(segment.expr, into);
};

const visitTemplateSegment = (segment: ExpressionSegment, into: DependencyAccumulator): void => {
  switch (segment.kind) {
    case "LiteralSegment":
    case "CommentSegment":
      return;
    case "InterpolationSegment":
      visitNode(segment.expression, into);
      return;
    case "ShellParamSegment":
    case "SecretRefSegment":
      into.analyzable = false;
      return;
  }
};

const analyzeExpressionDependencies = (ast: ExpressionTemplate | ExpressionNode): ExpressionDependencies => {
  const into: DependencyAccumulator = { scopes: new Set(), callees: new Set(), analyzable: true };
  if (isTemplate(ast)) for (const segment of ast.segments) visitTemplateSegment(segment, into);
  else visitNode(ast, into);
  return into;
};

/**
 * True when a parsed template or expression only reads the given context scopes
 * and calls only pure helpers.
 *
 * Literal text and template concatenation are always allowed. A helper that
 * reaches the host - `load`, `import`, `which`, `fs.*` and friends - is never
 * allowed, because those are capabilities rather than context reads. An unknown
 * callee is treated the same way: a caller that defers on this predicate would
 * otherwise keep executable syntax in an accepted document instead of failing.
 */
export const expressionTouchesOnlyScopes = (
  ast: ExpressionTemplate | ExpressionNode,
  allowed: ReadonlyArray<string>,
): boolean => {
  const dependencies = analyzeExpressionDependencies(ast);
  if (!dependencies.analyzable) return false;
  const allowedSet = new Set(allowed);
  for (const scope of dependencies.scopes) if (!allowedSet.has(scope)) return false;
  for (const callee of dependencies.callees) if (!PURE_EXPRESSION_HELPER_NAMES.has(callee)) return false;
  return true;
};
