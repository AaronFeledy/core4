import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import ts from "typescript";

import { ConfigError } from "@lando/sdk/errors";
import * as sdkServices from "@lando/sdk/services";
import type { LandofileServiceError } from "@lando/sdk/services";

import sdkPackage from "../../package.json";
import publicSurface from "../fixtures/sdk-public-surface.json";

const repoRoot = new URL("../../..", import.meta.url).pathname;
const servicesSourceDir = join(repoRoot, "sdk/src/services");

const normalizeSignature = (value: string): string =>
  value
    .replace(/readonly\s+/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*([(),:;<>|&?])\s*/g, "$1")
    .replace(/<\|/g, "<")
    .replace(/,\|/g, ",")
    .replace(/,\)/g, ")")
    .replace(/=>/g, " => ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/;$/, "");

// Every `Context.Service` contract lives in its own module under `sdk/src/services/`; `index.ts`
// only re-exports them. Parse the whole directory so a shape extracted into a named interface in
// one module still resolves when the class that references it sits in the same or another module.
const serviceSourceFiles: ReadonlyArray<ts.SourceFile> = readdirSync(servicesSourceDir)
  .filter((entry) => entry.endsWith(".ts") && entry !== "index.ts")
  .sort()
  .map((entry) => {
    const path = join(servicesSourceDir, entry);
    return ts.createSourceFile(
      path,
      readFileSync(path, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
  });

const interfaces = new Map<string, ts.InterfaceDeclaration>();
for (const sourceFile of serviceSourceFiles) {
  for (const statement of sourceFile.statements) {
    if (ts.isInterfaceDeclaration(statement)) interfaces.set(statement.name.text, statement);
  }
}

const serviceShapeMembers = (typeNode: ts.TypeNode): ReadonlyArray<string> => {
  if (ts.isTypeLiteralNode(typeNode)) {
    return typeNode.members.map((member) => normalizeSignature(member.getText())).sort();
  }

  if (ts.isTypeReferenceNode(typeNode) && ts.isIdentifier(typeNode.typeName)) {
    const interfaceDeclaration = interfaces.get(typeNode.typeName.text);
    if (interfaceDeclaration === undefined) return [];
    return interfaceDeclaration.members.map((member) => normalizeSignature(member.getText())).sort();
  }

  return [];
};

const tagTypeArguments = (expression: ts.Expression): ts.NodeArray<ts.TypeNode> | undefined => {
  if (!ts.isCallExpression(expression)) return undefined;
  return expression.typeArguments ?? tagTypeArguments(expression.expression);
};

const currentServiceTagSignatures = (): Record<string, ReadonlyArray<string>> => {
  const tags: Record<string, ReadonlyArray<string>> = {};

  for (const sourceFile of serviceSourceFiles) {
    for (const statement of sourceFile.statements) {
      if (!ts.isClassDeclaration(statement) || statement.name === undefined) continue;
      if (!statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;

      const contextServiceHeritage = statement.heritageClauses
        ?.flatMap((clause) => clause.types)
        .find((heritage) => heritage.getText().includes("Context.Service"));
      if (contextServiceHeritage === undefined) continue;

      const shapeType = tagTypeArguments(contextServiceHeritage.expression)?.[1];
      if (shapeType === undefined) continue;

      tags[statement.name.text] = serviceShapeMembers(shapeType);
    }
  }

  return tags;
};

// Public changes must update sdk/test/fixtures/sdk-public-surface.json in the same change.
describe("SDK public-surface snapshot", () => {
  test("matches every Landofile service failure tag", () => {
    const tags = {
      ComposeKeyRejectedError: true,
      Lando3LandofileDetected: true,
      LandofileDialectMixError: true,
      LandofileFormConflictError: true,
      LandofileImportRefMisuseError: true,
      LandofileIncludeError: true,
      LandofileLoadLimitError: true,
      LandofileLoadOutsideRootError: true,
      LandofileLockMismatchError: true,
      LandofileNotFoundError: true,
      LandofileParseError: true,
      LandofileSandboxError: true,
      LandofileTimeoutError: true,
      LandofileValidationError: true,
      ManagedFileTransactionError: true,
      NotImplementedError: true,
      RouteInputError: true,
      ToolingIncludeCycleError: true,
    } satisfies Record<LandofileServiceError["_tag"], true>;
    expect(Object.keys(tags).sort()).toEqual(publicSurface.landofileServiceErrorTags);
  });
  test("matches the structured global config error fields", () => {
    expect(Object.keys(ConfigError.fields).sort()).toEqual(publicSurface.configErrorFields);
  });
  test("matches every package export subpath", () => {
    expect(Object.keys(publicSurface.subpathExports).sort()).toEqual(Object.keys(sdkPackage.exports).sort());
  });

  for (const [subpath, expectedNames] of Object.entries(publicSurface.subpathExports)) {
    test(`matches runtime exports for ${subpath}`, async () => {
      const specifier = subpath === "." ? "@lando/sdk" : `@lando/sdk/${subpath.slice(2)}`;
      const exports = await import(specifier);
      expect(Object.keys(exports).sort()).toEqual(expectedNames);
    });
  }

  test("re-exports every declared service tag through the public services barrel", () => {
    const exportedServiceNames = Object.keys(sdkServices);
    for (const tagName of Object.keys(currentServiceTagSignatures())) {
      expect(exportedServiceNames).toContain(tagName);
    }
  });

  test("matches all service tags and their normalized member signatures", () => {
    const expectedTags = Object.fromEntries(
      Object.entries(publicSurface.serviceTags).map(([tag, signatures]) => [
        tag,
        signatures.map(normalizeSignature).sort(),
      ]),
    );
    expect(currentServiceTagSignatures()).toEqual(expectedTags);
  });
});
