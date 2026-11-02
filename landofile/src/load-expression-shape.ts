import { type ExpressionNode, type ExpressionTemplate, parseExpressionEither } from "@lando/sdk/expressions";
import type { ParsedPendingSite } from "@lando/sdk/schema";
import { Predicate, Result } from "effect";
import type { LandofileLoadPolicy, LandofileLoadSource } from "./load-expression-file.ts";
import type { LoadFailureRecorder } from "./load-failures.ts";
import { eligibleBindingPath } from "./secret-reference.ts";

export const keyValueEntryPath = (path: readonly (string | number)[]): boolean =>
  eligibleBindingPath(path) ||
  (path[0] === "services" &&
    ((path[2] === "labels" && path.length === 4) ||
      (path[2] === "build" && path[3] === "args" && path.length === 5)));

export const keyValueEntryHasExpression = (
  value: string,
  path: readonly (string | number)[],
  filePath: string,
): boolean => {
  if (typeof path.at(-1) !== "number" || !keyValueEntryPath(path)) return false;
  const equal = value.indexOf("=");
  const key = equal < 0 ? value : value.slice(0, equal);
  const parsed = parseExpressionEither(key, { filePath, bareShellParameters: "preserve" });
  return (
    Result.isFailure(parsed) || parsed.success.segments.some((segment) => segment.kind !== "LiteralSegment")
  );
};

export interface ResolveLandofileLoadExpressionsOptions {
  readonly pathPrefix?: readonly (string | number)[];
  readonly recorder?: LoadFailureRecorder | undefined;
  readonly value: unknown;
  readonly source: LandofileLoadSource;
  readonly policy: LandofileLoadPolicy;
  readonly pendingSites?: ParsedPendingSite[] | undefined;
}

export const invalidImportRefPath = (
  value: unknown,
  path: readonly (string | number)[],
): readonly (string | number)[] | undefined => {
  if (!Predicate.isObjectOrArray(value)) return undefined;
  if ("_tag" in value && value._tag === "ImportRef") {
    const accepted =
      (path.length === 4 || (path.length === 5 && typeof path[4] === "number")) &&
      path[0] === "services" &&
      path[2] === "security" &&
      ["ca", "cas", "certificate-authority", "certificate-authorities"].includes(String(path[3]));
    return accepted ? undefined : path;
  }
  for (const [key, entry] of Object.entries(value)) {
    const nested = invalidImportRefPath(entry, [...path, Array.isArray(value) ? Number(key) : key]);
    if (nested !== undefined) return nested;
  }
  return undefined;
};

export const callDepth = (node: ExpressionNode): number => {
  switch (node.kind) {
    case "Literal":
    case "Path":
      return 0;
    case "ArrayLiteral":
      return Math.max(0, ...node.elements.map(callDepth));
    case "ObjectLiteral":
      return Math.max(0, ...node.entries.map((entry) => callDepth(entry.value)));
    case "Access":
      return callDepth(node.target);
    case "Conditional":
      return Math.max(callDepth(node.test), callDepth(node.consequent), callDepth(node.alternate));
    case "Call":
      return (
        Math.max(0, ...node.args.map(callDepth)) +
        (node.callee === "load" || node.callee === "import" ? 1 : 0)
      );
    default:
      return node satisfies never;
  }
};

export const containsLoad = (node: ExpressionNode): boolean => {
  switch (node.kind) {
    case "Literal":
    case "Path":
      return false;
    case "ArrayLiteral":
      return node.elements.some(containsLoad);
    case "ObjectLiteral":
      return node.entries.some((entry) => containsLoad(entry.value));
    case "Access":
      return containsLoad(node.target);
    case "Conditional":
      return containsLoad(node.test) || containsLoad(node.consequent) || containsLoad(node.alternate);
    case "Call":
      return node.callee === "load" || node.callee === "import" || node.args.some(containsLoad);
    default:
      return node satisfies never;
  }
};

export const containsContextPath = (node: ExpressionNode): boolean => {
  switch (node.kind) {
    case "Literal":
      return false;
    case "Path":
      return true;
    case "ArrayLiteral":
      return node.elements.some(containsContextPath);
    case "ObjectLiteral":
      return node.entries.some((entry) => containsContextPath(entry.value));
    case "Access":
      return (
        containsContextPath(node.target) ||
        node.segments.some((segment) => segment.type === "dynamic" && containsContextPath(segment.expr))
      );
    case "Conditional":
      return (
        containsContextPath(node.test) ||
        containsContextPath(node.consequent) ||
        containsContextPath(node.alternate)
      );
    case "Call":
      return node.args.some(containsContextPath);
    default:
      return node satisfies never;
  }
};

export const templateExpression = (template: ExpressionTemplate): ExpressionNode | undefined => {
  if (!template.whole) return undefined;
  const segment = template.segments[0];
  return segment?.kind === "InterpolationSegment" ? segment.expression : undefined;
};
