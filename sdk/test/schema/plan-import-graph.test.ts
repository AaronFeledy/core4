import { expect, test } from "bun:test";
import { basename, dirname, relative, resolve } from "node:path";
import ts from "@typescript/typescript6";

const root = resolve(import.meta.dir, "../../src");
const authoring =
  /^(?:config|environment-input|host-events|landofile(?:-.*)?|build-block|property-name-check)\.ts$/u;

test("canonical plan modules do not import authoring codecs", async () => {
  const seen = new Set<string>();
  const violations: string[] = [];
  const visit = async (file: string, chain: readonly string[]) => {
    if (seen.has(file)) return;
    seen.add(file);
    const path = [...chain, relative(root, file)];
    if (authoring.test(basename(file)) || file === resolve(root, "schema/index.ts")) {
      violations.push(path.join(" -> "));
      return;
    }
    const source = ts.createSourceFile(file, await Bun.file(file).text(), ts.ScriptTarget.Latest);
    for (const node of source.statements) {
      if (
        ts.isImportDeclaration(node) &&
        (node.importClause?.isTypeOnly ||
          (node.importClause?.name === undefined &&
            node.importClause?.namedBindings !== undefined &&
            ts.isNamedImports(node.importClause.namedBindings) &&
            node.importClause.namedBindings.elements.length > 0 &&
            node.importClause.namedBindings.elements.every((entry) => entry.isTypeOnly)))
      )
        continue;
      if (ts.isExportDeclaration(node) && node.isTypeOnly) continue;
      if (!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) continue;
      const name = node.moduleSpecifier;
      if (name && ts.isStringLiteral(name) && name.text.startsWith(".")) {
        await visit(resolve(dirname(file), name.text), path);
      }
    }
  };
  for (const name of ["app-plan", "applied-state", "event-plan", "compiled-tooling-task"]) {
    await visit(resolve(root, `schema/${name}.ts`), []);
  }
  expect(violations).toEqual([]);
});
