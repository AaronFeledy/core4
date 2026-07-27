import ts from "typescript";

import type { Diagnostic, Rule } from "../types.ts";

const propertyName = (node: ts.PropertyName): string | undefined => {
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) return node.text;
  if (ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text;
  return undefined;
};

const directWriteMatch = (node: ts.CallExpression): string | undefined => {
  const expression = node.expression;
  if (!ts.isPropertyAccessExpression(expression)) return undefined;

  const method = propertyName(expression.name);
  const target = expression.expression;

  if (ts.isIdentifier(target) && target.text === "console") {
    return method === undefined ? "console.<computed>" : `console.${method}`;
  }

  if (method !== "write" || !ts.isPropertyAccessExpression(target)) return undefined;
  const stream = propertyName(target.name);
  const processExpression = target.expression;
  if (
    ts.isIdentifier(processExpression) &&
    processExpression.text === "process" &&
    (stream === "stdout" || stream === "stderr")
  ) {
    return `process.${stream}.write`;
  }

  return undefined;
};

const analyzeSource = (file: string, source: ts.SourceFile): ReadonlyArray<Diagnostic> => {
  const diagnostics: Diagnostic[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const match = directWriteMatch(node);
      if (match !== undefined) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        diagnostics.push({
          ruleId: "renderer-boundary",
          file,
          line: line + 1,
          message: match,
        });
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return diagnostics;
};

export const rendererBoundaryRule: Rule = {
  id: "renderer-boundary",
  title: "Renderer boundary",
  failureHeadline:
    "Renderer boundary check failed. Direct console/process writes must route through the Renderer boundary.",
  async run(context) {
    const files = await context.files("core-and-plugin-sources");
    return (
      await Promise.all(
        files.map(async (file) => analyzeSource(file.relativePath, await context.sourceFile(file))),
      )
    ).flat();
  },
};
