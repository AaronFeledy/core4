import ts from "typescript";

import type { Diagnostic, InventoryFile, Rule } from "../types.ts";

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

const scanFile = (file: InventoryFile, source: ts.SourceFile): ReadonlyArray<Diagnostic> => {
  const diagnostics: Diagnostic[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isForbiddenJoin(node)) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      diagnostics.push({
        ruleId: "paths-boundary",
        file: file.relativePath,
        line: line + 1,
        message: node.getText(source),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return diagnostics;
};

export const pathsBoundaryRule: Rule = {
  id: "paths-boundary",
  title: "Paths boundary",
  failureHeadline:
    "Paths boundary check failed. Hand-rolled root joins must use @lando/core/paths (makeLandoPaths) or PathsService.",
  async run(context) {
    const files = await context.files("core-and-plugin-sources");
    return (await Promise.all(files.map(async (file) => scanFile(file, await context.sourceFile(file)))))
      .flat()
      .sort((left, right) => left.file.localeCompare(right.file) || (left.line ?? 0) - (right.line ?? 0));
  },
};
