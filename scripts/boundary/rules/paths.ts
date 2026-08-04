import ts from "typescript";

import type { BoundaryRule, FileContext } from "../types.ts";

// Each forbidden join pairs a root-identifier suffix with a literal segment.
const FORBIDDEN_JOINS: ReadonlyArray<{ readonly rootSuffix: string; readonly segment: string }> = [
  { rootSuffix: "userdataroot", segment: "plugins" },
  { rootSuffix: "usercacheroot", segment: "scratch" },
  { rootSuffix: "userdataroot", segment: "bin" },
];

const JOIN_CALLEES = new Set(["join", "resolve"]);

const calleeName = (expression: ts.LeftHandSideExpression): string | undefined => {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return undefined;
};

const rootIdentifierSuffix = (node: ts.Expression): string | undefined => {
  const name = ts.isIdentifier(node)
    ? node.text
    : ts.isPropertyAccessExpression(node)
      ? node.name.text
      : undefined;
  return name?.toLowerCase();
};

const literalText = (node: ts.Expression): string | undefined =>
  ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : undefined;

const isForbiddenJoin = (call: ts.CallExpression): boolean => {
  const callee = calleeName(call.expression);
  if (callee === undefined || !JOIN_CALLEES.has(callee)) return false;
  const [first, second] = call.arguments;
  if (first === undefined || second === undefined) return false;
  const suffix = rootIdentifierSuffix(first);
  const segment = literalText(second);
  if (suffix === undefined || segment === undefined) return false;
  return FORBIDDEN_JOINS.some((entry) => suffix.endsWith(entry.rootSuffix) && segment === entry.segment);
};

const onNode = (node: ts.Node, context: FileContext): void => {
  if (!ts.isCallExpression(node) || !isForbiddenJoin(node)) return;
  const source = node.getSourceFile();
  const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
  context.report({ line: line + 1, detail: node.getText(source) });
};

export const pathsRule = {
  id: "paths",
  scope: {
    roots: ["core/src", "plugins"],
    extensions: [".ts"],
    excludeTestFiles: true,
  },
  carveOuts: { files: [], prefixes: [] },
  passMessage: "Paths boundary check passed.",
  failureHeadline:
    "Paths boundary check failed. Hand-rolled root joins must use @lando/core/paths (makeLandoPaths) or PathsService.",
  onNode,
} satisfies BoundaryRule;
