import ts from "typescript";

import type { BoundaryRule } from "../types.ts";
import { CORE_AND_PLUGIN_SOURCE_ROOTS } from "../workspace-roots.ts";

const propertyName = (node: ts.PropertyName): string | undefined => {
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) return node.text;
  if (ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text;
  return undefined;
};

const directWriteMatch = (node: ts.PropertyAccessExpression): string | undefined => {
  const method = propertyName(node.name);
  const target = node.expression;

  if (ts.isIdentifier(target) && target.text === "console") {
    return method === undefined ? "console.<computed>" : `console.${method}`;
  }

  if (method !== "write" || !ts.isPropertyAccessExpression(target)) return undefined;
  const stream = propertyName(target.name);
  const processExpression = target.expression;
  if (ts.isIdentifier(processExpression) && processExpression.text === "process") {
    if (stream === "stdout" || stream === "stderr") return `process.${stream}.write`;
  }

  return undefined;
};

export const rendererRule = {
  id: "renderer",
  scope: {
    roots: [...CORE_AND_PLUGIN_SOURCE_ROOTS.filter((root) => root !== "renderer/src"), "core/bin"],
    extensions: [".ts"],
    excludeTestFiles: true,
  },
  carveOuts: { files: [], prefixes: [] },
  passMessage: "Renderer boundary check passed.",
  failureHeadline:
    "Renderer boundary check failed. Direct console/process writes must route through the Renderer boundary.",
  onNode: (node, context) => {
    if (!ts.isPropertyAccessExpression(node)) return;
    const match = directWriteMatch(node);
    if (match === undefined) return;
    const source = node.getSourceFile();
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    context.report({ line: line + 1, detail: match });
  },
} satisfies BoundaryRule;
