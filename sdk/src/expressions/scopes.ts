import type { ExpressionNode, ExpressionSegment, ExpressionTemplate, PathSegment } from "./ast.ts";

const isTemplate = (ast: ExpressionTemplate | ExpressionNode): ast is ExpressionTemplate => "whole" in ast;

const segmentTouchesOnlyScopes = (segment: PathSegment, allowed: ReadonlySet<string>): boolean => {
  switch (segment.type) {
    case "prop":
    case "index":
    case "key":
      return true;
    case "dynamic":
      return nodeTouchesOnlyScopes(segment.expr, allowed);
  }
};

const nodeTouchesOnlyScopes = (node: ExpressionNode, allowed: ReadonlySet<string>): boolean => {
  switch (node.kind) {
    case "Literal":
      return true;
    case "Path":
      return (
        allowed.has(node.head) && node.segments.every((segment) => segmentTouchesOnlyScopes(segment, allowed))
      );
    case "Access":
      return (
        nodeTouchesOnlyScopes(node.target, allowed) &&
        node.segments.every((segment) => segmentTouchesOnlyScopes(segment, allowed))
      );
    case "ArrayLiteral":
      return node.elements.every((element) => nodeTouchesOnlyScopes(element, allowed));
    case "ObjectLiteral":
      return node.entries.every((entry) => nodeTouchesOnlyScopes(entry.value, allowed));
    case "Call":
    case "Conditional":
      return false;
  }
};

const templateSegmentTouchesOnlyScopes = (
  segment: ExpressionSegment,
  allowed: ReadonlySet<string>,
): boolean => {
  switch (segment.kind) {
    case "LiteralSegment":
    case "CommentSegment":
      return true;
    case "InterpolationSegment":
      return nodeTouchesOnlyScopes(segment.expression, allowed);
    case "ShellParamSegment":
    case "SecretRefSegment":
      return false;
  }
};

/**
 * True when a parsed template or expression node only reads the given context
 * scopes, plus string literals / template concatenation.
 */
export const expressionTouchesOnlyScopes = (
  ast: ExpressionTemplate | ExpressionNode,
  allowed: ReadonlyArray<string>,
): boolean => {
  const allowedSet = new Set(allowed);
  if (isTemplate(ast)) {
    return ast.segments.every((segment) => templateSegmentTouchesOnlyScopes(segment, allowedSet));
  }
  return nodeTouchesOnlyScopes(ast, allowedSet);
};
