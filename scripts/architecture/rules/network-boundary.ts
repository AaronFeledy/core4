import ts from "typescript";

import type { Diagnostic, InventoryFile, Rule } from "../types.ts";

const GLOBAL_OBJECTS = new Set(["globalThis", "Bun", "self", "window"]);

const matchGlobalFetchCall = (call: ts.CallExpression): string | undefined => {
  const callee = call.expression;
  if (ts.isIdentifier(callee) && callee.text === "fetch") return "fetch";

  if (ts.isPropertyAccessExpression(callee) && callee.name.text === "fetch") {
    const target = callee.expression;
    if (ts.isIdentifier(target) && GLOBAL_OBJECTS.has(target.text)) return `${target.text}.fetch`;
    return undefined;
  }

  if (ts.isElementAccessExpression(callee)) {
    const target = callee.expression;
    const argument = callee.argumentExpression;
    if (
      ts.isIdentifier(target) &&
      GLOBAL_OBJECTS.has(target.text) &&
      ts.isStringLiteralLike(argument) &&
      argument.text === "fetch"
    ) {
      return `${target.text}['fetch']`;
    }
  }

  return undefined;
};

const scanFile = (file: InventoryFile, source: ts.SourceFile): ReadonlyArray<Diagnostic> => {
  const diagnostics: Diagnostic[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const match = matchGlobalFetchCall(node);
      if (match !== undefined) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        diagnostics.push({
          ruleId: "network-boundary",
          file: file.relativePath,
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

export const networkBoundaryRule: Rule = {
  id: "network-boundary",
  title: "Network boundary",
  failureHeadline:
    "Network boundary check failed. Lando-owned outbound HTTP must route through the HttpClient adapter (@lando/core HttpClient), not direct global fetch. Carve-outs are limited to BunSelfRunner package-manager ops and the standalone installer scripts.",
  async run(context) {
    const files = await context.files("core-and-plugin-sources");
    return (await Promise.all(files.map(async (file) => scanFile(file, await context.sourceFile(file)))))
      .flat()
      .sort((left, right) => left.file.localeCompare(right.file) || (left.line ?? 0) - (right.line ?? 0));
  },
};
