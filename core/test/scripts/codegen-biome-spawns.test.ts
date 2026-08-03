import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { expect, test } from "bun:test";
import ts from "typescript";

import { biomeCheckArgv } from "../../../scripts/_codegen-output.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const scriptsRoot = resolve(repoRoot, "scripts");

const hasDirectBiomeSpawn = (path: string, source: string): boolean => {
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isCallExpression(node) &&
      ((ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "spawn") ||
        (ts.isIdentifier(node.expression) && node.expression.text === "spawn")) &&
      node.arguments.some((argument) => /["']biome["']/u.test(argument.getText(sourceFile)))
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
};

test("centralizes direct Biome process execution in the codegen output helper", async () => {
  // Given
  const entries = await readdir(scriptsRoot, { withFileTypes: true });
  const scriptNames = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts") && entry.name !== "_codegen-output.ts")
    .map((entry) => entry.name)
    .sort();

  // When
  const directSpawnFiles: string[] = [];
  for (const scriptName of scriptNames) {
    const path = resolve(scriptsRoot, scriptName);
    if (hasDirectBiomeSpawn(path, await Bun.file(path).text())) directSpawnFiles.push(scriptName);
  }

  // Then
  expect(directSpawnFiles).toEqual([]);
});

test("shared Biome argv keeps unmatched paths observable", () => {
  // Given / When
  const argv = biomeCheckArgv([resolve(repoRoot, "dist/unmatched")]);

  // Then
  expect(argv).not.toContain("--no-errors-on-unmatched");
});

test("shared Biome argv formats explicit ignored generated paths", () => {
  // Given / When
  const argv = biomeCheckArgv([resolve(repoRoot, "core/src/plugins/generated/bundled.ts")]);

  // Then
  expect(argv).toContain("--vcs-use-ignore-file=false");
});
