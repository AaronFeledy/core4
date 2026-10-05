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

/**
 * How to read `${VAR}` and `${secret:...}` template text.
 *
 * `dependency` treats it as a host/secret read the caller must not accept
 * blindly. `inert` treats it as opaque TEXT belonging to whoever consumes the
 * rendered string - a container shell, for instance - so only the `{{ ... }}`
 * interpolations count as reads.
 */
type ShellTextReading = "dependency" | "inert";

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

const visitTemplateSegment = (
  segment: ExpressionSegment,
  into: DependencyAccumulator,
  shellText: ShellTextReading,
): void => {
  switch (segment.kind) {
    case "LiteralSegment":
    case "CommentSegment":
      return;
    case "InterpolationSegment":
      visitNode(segment.expression, into);
      return;
    case "ShellParamSegment":
    case "SecretRefSegment":
      if (shellText === "dependency") into.analyzable = false;
      return;
  }
};

const analyzeExpressionDependencies = (
  ast: ExpressionTemplate | ExpressionNode,
  shellText: ShellTextReading,
): ExpressionDependencies => {
  const into: DependencyAccumulator = { scopes: new Set(), callees: new Set(), analyzable: true };
  if (isTemplate(ast)) for (const segment of ast.segments) visitTemplateSegment(segment, into, shellText);
  else visitNode(ast, into);
  return into;
};

const satisfies = (dependencies: ExpressionDependencies, allowed: ReadonlyArray<string>): boolean => {
  if (!dependencies.analyzable) return false;
  const allowedSet = new Set(allowed);
  for (const scope of dependencies.scopes) if (!allowedSet.has(scope)) return false;
  for (const callee of dependencies.callees) if (!PURE_EXPRESSION_HELPER_NAMES.has(callee)) return false;
  return true;
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
): boolean => satisfies(analyzeExpressionDependencies(ast, "dependency"), allowed);

/**
 * True when every `{{ ... }}` interpolation in a template reads only the given
 * context scopes through pure helpers, treating `${VAR}` and `${secret:...}`
 * text as inert.
 *
 * This answers a deliberately narrower question than
 * {@link expressionTouchesOnlyScopes}: whether the EXPRESSIONS in a string are
 * safe to resolve, not whether the whole string is free of host-shaped syntax.
 * A caller that replays the shell and secret text verbatim instead of
 * evaluating it - because that text belongs to a shell it will hand the string
 * to - wants this predicate. A caller that is about to evaluate the template as
 * written wants the stricter one, because the evaluator resolves `${VAR}` from
 * the `env` scope and `${secret:...}` from the secret scope.
 */
export const expressionInterpolationsTouchOnlyScopes = (
  ast: ExpressionTemplate | ExpressionNode,
  allowed: ReadonlyArray<string>,
): boolean => satisfies(analyzeExpressionDependencies(ast, "inert"), allowed);

/**
 * The members a parsed template or expression reads under one scope, e.g. the
 * service names behind `services.<name>.creds.*`.
 *
 * A member is the first path segment after the scope head when that segment is
 * static (`services.database`, `services["database"]`). A read of the bare
 * scope or through a computed segment (`services[name]`) cannot be attributed
 * to one member, so `analyzable` turns false and the caller must not treat the
 * set as complete.
 */
export const expressionScopeMembers = (
  ast: ExpressionTemplate | ExpressionNode,
  scope: string,
): { readonly members: ReadonlySet<string>; readonly analyzable: boolean } => {
  const members = new Set<string>();
  let analyzable = true;
  const visitPath = (head: string, segments: ReadonlyArray<PathSegment>): void => {
    if (head !== scope) return;
    const first = segments[0];
    if (first?.type === "prop") members.add(first.name);
    else if (first?.type === "key") members.add(first.key);
    else analyzable = false;
  };
  const visit = (node: ExpressionNode): void => {
    switch (node.kind) {
      case "Literal":
        return;
      case "Path":
        visitPath(node.head, node.segments);
        for (const segment of node.segments) if (segment.type === "dynamic") visit(segment.expr);
        return;
      case "Access":
        if (node.target.kind === "Path" && node.target.head === scope && node.target.segments.length === 0) {
          visitPath(scope, node.segments);
        } else {
          visit(node.target);
        }
        for (const segment of node.segments) if (segment.type === "dynamic") visit(segment.expr);
        return;
      case "ArrayLiteral":
        for (const element of node.elements) visit(element);
        return;
      case "ObjectLiteral":
        for (const entry of node.entries) visit(entry.value);
        return;
      case "Conditional":
        visit(node.test);
        visit(node.consequent);
        visit(node.alternate);
        return;
      case "Call":
        for (const argument of node.args) visit(argument);
        return;
    }
  };
  if (isTemplate(ast)) {
    for (const segment of ast.segments) {
      if (segment.kind === "InterpolationSegment") visit(segment.expression);
    }
  } else {
    visit(ast);
  }
  return { members, analyzable };
};
