import ts from "typescript";

import type { BoundaryRule } from "../types.ts";
import { CORE_AND_PLUGIN_SOURCE_ROOTS } from "../workspace-roots.ts";

const propertyName = (node: ts.PropertyName): string | undefined => {
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) return node.text;
  if (ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text;
  return undefined;
};

const directProperties = (node: ts.ObjectLiteralExpression): Map<string, ts.Expression> => {
  const props = new Map<string, ts.Expression>();
  for (const member of node.properties) {
    if (ts.isPropertyAssignment(member)) {
      const name = propertyName(member.name);
      if (name !== undefined) props.set(name, member.initializer);
    } else if (ts.isShorthandPropertyAssignment(member)) {
      props.set(member.name.text, member.name);
    }
  }
  return props;
};

const isStringLiteralValue = (node: ts.Expression, value: string): boolean =>
  (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && node.text === value;

/** CommandResultEnvelope shape: direct keys apiVersion + command + ok + (result | error). */
const isCommandEnvelopeLiteral = (node: ts.Node): boolean => {
  if (!ts.isObjectLiteralExpression(node)) return false;
  const props = directProperties(node);
  if (!props.has("apiVersion") || !props.has("command") || !props.has("ok")) return false;
  if (!props.has("result") && !props.has("error")) return false;
  const apiVersion = props.get("apiVersion");
  if (apiVersion !== undefined && ts.isStringLiteralLike(apiVersion) && apiVersion.text !== "v4")
    return false;
  return true;
};

/** Result StreamFrame shape: direct `_tag: "result"` string literal + direct `envelope` key. */
const isStreamResultFrameLiteral = (node: ts.Node): boolean => {
  if (!ts.isObjectLiteralExpression(node)) return false;
  const props = directProperties(node);
  const tag = props.get("_tag");
  if (tag === undefined || !props.has("envelope")) return false;
  if (isStringLiteralValue(tag, "result")) return true;
  if (ts.isAsExpression(tag) && isStringLiteralValue(tag.expression, "result")) return true;
  return false;
};

const localInitializer = (name: string, scope: ts.Node): ts.Expression | undefined => {
  let found: ts.Expression | undefined;
  const visit = (node: ts.Node): void => {
    if (found !== undefined) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      if (node.initializer !== undefined) found = node.initializer;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(scope);
  return found;
};

type ResultShape = "envelope" | "frame";

const resultShapeOf = (node: ts.Node, scope: ts.Node, seen: Set<ts.Node>): ResultShape | undefined => {
  if (seen.has(node)) return undefined;
  seen.add(node);

  if (isStreamResultFrameLiteral(node)) return "frame";
  if (isCommandEnvelopeLiteral(node)) return "envelope";

  if (ts.isIdentifier(node)) {
    const initializer = localInitializer(node.text, scope);
    if (initializer !== undefined) return resultShapeOf(initializer, scope, seen);
    return undefined;
  }

  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
    return resultShapeOf(node.expression, scope, seen);
  }

  let shape: ResultShape | undefined;
  ts.forEachChild(node, (child) => {
    if (shape !== undefined) return;
    shape = resultShapeOf(child, scope, seen);
  });
  return shape;
};

const isJsonStringifyCall = (node: ts.CallExpression): boolean => {
  const expression = node.expression;
  return (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "JSON" &&
    expression.name.text === "stringify"
  );
};

const matchTextForShape = (node: ts.CallExpression, shape: ResultShape): string => {
  const arg = node.arguments[0];
  if (arg !== undefined && ts.isIdentifier(arg)) return `JSON.stringify(${arg.text})`;
  return shape === "frame"
    ? "JSON.stringify(<result-stream-frame>)"
    : "JSON.stringify(<command-result-envelope>)";
};

export const machineOutputRule = {
  id: "machine-output",
  scope: {
    roots: CORE_AND_PLUGIN_SOURCE_ROOTS,
    extensions: [".ts"],
    excludeTestFiles: true,
  },
  carveOuts: { files: [], prefixes: [] },
  passMessage: "Machine output boundary check passed.",
  failureHeadline:
    "Machine output boundary check failed. Command-result envelopes and result stream frames must serialize only through the canonical SDK encoders.",
  onNode: (node, context) => {
    const source = node.getSourceFile();
    if (ts.isCallExpression(node) && isJsonStringifyCall(node) && node.arguments[0] !== undefined) {
      const shape = resultShapeOf(node.arguments[0], source, new Set());
      if (shape !== undefined) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        context.report({ line: line + 1, detail: matchTextForShape(node, shape) });
      }
    }
  },
} satisfies BoundaryRule;
