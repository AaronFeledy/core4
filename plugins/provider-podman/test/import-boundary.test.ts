import { describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

const PACKAGE_ROOT = path.resolve(import.meta.dir, "..");
const SOURCE_ROOT = path.join(PACKAGE_ROOT, "src");
const REPO_ROOT = path.resolve(PACKAGE_ROOT, "..", "..");
const FORBIDDEN_PREFIXES = ["@oclif/core", "@oclif/"];
const FORBIDDEN_CORE_CLI_SEGMENT = `${path.sep}core${path.sep}src${path.sep}cli${path.sep}`;

type ImportBoundaryViolation = {
  file: string;
  line: number;
  specifier: string;
};

const sourceFiles = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(absolutePath);
      if (entry.isFile() && absolutePath.endsWith(".ts")) return [absolutePath];
      return [];
    }),
  );
  return files.flat().sort();
};

const moduleSpecifierText = (node: ts.ImportDeclaration | ts.ExportDeclaration): string | undefined => {
  if (node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
    return node.moduleSpecifier.text;
  }
  return undefined;
};

const isForbiddenSpecifier = (specifier: string, containingFile: string) => {
  if (FORBIDDEN_PREFIXES.some((prefix) => specifier === prefix || specifier.startsWith(prefix))) return true;
  if (specifier.includes("core/src/cli/")) return true;
  if (specifier.startsWith(".")) {
    const resolved = path.resolve(path.dirname(containingFile), specifier);
    return resolved.startsWith(REPO_ROOT) && resolved.includes(FORBIDDEN_CORE_CLI_SEGMENT);
  }
  return false;
};

const importViolations = async () => {
  const violations: ImportBoundaryViolation[] = [];
  for (const file of await sourceFiles(SOURCE_ROOT)) {
    const content = await readFile(file, "utf8");
    const sourceFile = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const visit = (node: ts.Node) => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        const specifier = moduleSpecifierText(node);
        if (specifier !== undefined && isForbiddenSpecifier(specifier, file)) {
          const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          violations.push({
            file: path.relative(PACKAGE_ROOT, file),
            line: line + 1,
            specifier,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sourceFile, visit);
  }
  return violations;
};

describe("@lando/provider-podman import boundary", () => {
  test("does not import OCLIF or core CLI internals", async () => {
    expect(await importViolations()).toEqual([]);
  });
});
