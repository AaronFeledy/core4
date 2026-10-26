import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test } from "bun:test";
import ts from "typescript";

import { CORE_AND_PLUGIN_SOURCE_ROOTS } from "../../../scripts/boundary/workspace-roots.ts";

const root = resolve(import.meta.dir, "../../..");

test("shipped non-SDK TaggedErrors declare remediation", () => {
  // Given every shipped source root, not a frozen list of known error files.
  const declarations: string[] = [];
  const missing: string[] = [];
  for (const sourceRoot of CORE_AND_PLUGIN_SOURCE_ROOTS) {
    for (const file of new Bun.Glob("**/*.ts").scanSync({ cwd: resolve(root, sourceRoot) })) {
      if (sourceRoot === "plugins" && !file.includes("/src/")) continue;
      const path = `${sourceRoot}/${file}`;
      const source = ts.createSourceFile(
        path,
        readFileSync(resolve(root, path), "utf8"),
        ts.ScriptTarget.Latest,
        true,
      );
      const visit = (node: ts.Node): void => {
        if (ts.isClassDeclaration(node)) {
          for (const heritage of node.heritageClauses?.flatMap((clause) => clause.types) ?? []) {
            const expression = heritage.expression;
            if (!ts.isCallExpression(expression) || !ts.isCallExpression(expression.expression)) continue;
            const factory = expression.expression.expression;
            if (!ts.isPropertyAccessExpression(factory) || factory.name.text !== "TaggedError") continue;
            const name = `${path}:${node.name?.text ?? "<anonymous>"}`;
            declarations.push(name);
            const fields = expression.arguments[1];
            // When inspecting the actual TaggedError field declaration.
            if (
              !fields ||
              !ts.isObjectLiteralExpression(fields) ||
              !fields.properties.some((property) => property.name?.getText(source) === "remediation")
            )
              missing.push(name);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }
  // Then enumeration is live and every class has the diagnostic field.
  expect(declarations.length).toBeGreaterThan(0);
  expect(missing).toEqual([]);
});
