import { Result } from "effect";
import type { ExpressionNode, PathSegment } from "../expressions/ast.ts";
import { evaluateExpressionEither } from "../expressions/evaluator.ts";

// Snapshot-source transport, recognized only in authored Literal nodes, never
// in evaluated options/helper output. Keep this wire prefix stable for snapshots.
const AUTHORED_BASE64_PREFIX = "lando:authoring:base64:";

/** Decode only the explicit authored-literal transport before any evaluation. */
export const decodeSnapshotSourceLiterals = (expression: ExpressionNode) => {
  const segment = (value: PathSegment): PathSegment =>
    value.type === "dynamic" ? { ...value, expr: visit(value.expr) } : value;
  const visit = (node: ExpressionNode): ExpressionNode => {
    switch (node.kind) {
      case "Literal": {
        if (typeof node.value !== "string" || !node.value.startsWith(AUTHORED_BASE64_PREFIX)) return node;
        const decoded = Result.getOrThrow(
          evaluateExpressionEither(
            {
              kind: "Call",
              callee: "b64decode",
              args: [{ kind: "Literal", value: node.value.slice(AUTHORED_BASE64_PREFIX.length) }],
            },
            {},
          ),
        );
        return typeof decoded === "string" ? { kind: "Literal", value: decoded } : node;
      }
      case "ArrayLiteral":
        return { ...node, elements: node.elements.map(visit) };
      case "ObjectLiteral":
        return { ...node, entries: node.entries.map((entry) => ({ ...entry, value: visit(entry.value) })) };
      case "Conditional":
        return {
          ...node,
          test: visit(node.test),
          consequent: visit(node.consequent),
          alternate: visit(node.alternate),
        };
      case "Call":
        return { ...node, args: node.args.map(visit) };
      case "Path":
        return { ...node, segments: node.segments.map(segment) };
      case "Access":
        return { ...node, target: visit(node.target), segments: node.segments.map(segment) };
      default:
        return node satisfies never;
    }
  };
  return Result.try({ try: () => visit(expression), catch: () => "Invalid authored literal transport." });
};
