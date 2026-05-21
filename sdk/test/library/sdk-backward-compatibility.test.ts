import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import ts from "typescript";

import * as sdkSchema from "@lando/sdk/schema";

type FrozenSdkSurface = {
  readonly schemaNames: ReadonlyArray<string>;
  readonly serviceTags: Readonly<Record<string, ReadonlyArray<string>>>;
};

const repoRoot = new URL("../../..", import.meta.url).pathname;
const fixturePath = join(repoRoot, "sdk/test/fixtures/sdk-mvp-surface.json");
const compatibilityDocPath = join(repoRoot, "sdk/API_COMPATIBILITY.md");
const servicesSourcePath = join(repoRoot, "sdk/src/services/index.ts");

const frozenSurface = JSON.parse(readFileSync(fixturePath, "utf8")) as FrozenSdkSurface;
const compatibilityDoc = readFileSync(compatibilityDocPath, "utf8");

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

const sourceFile = ts.createSourceFile(
  servicesSourcePath,
  readFileSync(servicesSourcePath, "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);

const interfaces = new Map<string, ts.InterfaceDeclaration>();
for (const statement of sourceFile.statements) {
  if (ts.isInterfaceDeclaration(statement)) interfaces.set(statement.name.text, statement);
}

const serviceShapeMembers = (typeNode: ts.TypeNode): ReadonlyArray<string> => {
  if (ts.isTypeLiteralNode(typeNode)) {
    return typeNode.members.map((member) => normalizeSignature(member.getText(sourceFile))).sort();
  }

  if (ts.isTypeReferenceNode(typeNode) && ts.isIdentifier(typeNode.typeName)) {
    const interfaceDeclaration = interfaces.get(typeNode.typeName.text);
    if (interfaceDeclaration === undefined) return [];
    return interfaceDeclaration.members
      .map((member) => normalizeSignature(member.getText(sourceFile)))
      .sort();
  }

  return [];
};

const tagTypeArguments = (expression: ts.Expression): ts.NodeArray<ts.TypeNode> | undefined => {
  if (!ts.isCallExpression(expression)) return undefined;
  return expression.typeArguments ?? tagTypeArguments(expression.expression);
};

const currentServiceTagSignatures = (): Record<string, ReadonlyArray<string>> => {
  const tags: Record<string, ReadonlyArray<string>> = {};

  for (const statement of sourceFile.statements) {
    if (!ts.isClassDeclaration(statement) || statement.name === undefined) continue;
    if (!statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;

    const contextTagHeritage = statement.heritageClauses
      ?.flatMap((clause) => clause.types)
      .find((heritage) => heritage.getText(sourceFile).includes("Context.Tag"));
    if (contextTagHeritage === undefined) continue;

    const shapeType = tagTypeArguments(contextTagHeritage.expression)?.[1];
    if (shapeType === undefined) continue;

    tags[statement.name.text] = serviceShapeMembers(shapeType);
  }

  return tags;
};

const documentedNames = (heading: string): ReadonlyArray<string> => {
  const [, section = ""] = compatibilityDoc.split(`## ${heading}`);
  const [body = ""] = section.split("\n## ");
  return [...body.matchAll(/`([^`]+)`/g)]
    .map((match) => match[1] ?? "")
    .filter(Boolean)
    .sort();
};

describe("SDK backward-compatibility surface", () => {
  test("keeps MVP schema exports available while allowing additive Alpha exports", () => {
    const exportedSchemaNames = Object.keys(sdkSchema).sort();

    for (const schemaName of frozenSurface.schemaNames) {
      expect(exportedSchemaNames).toContain(schemaName);
    }
  });

  test("keeps MVP service tag method signatures stable", () => {
    const serviceTags = currentServiceTagSignatures();

    for (const [tagName, expectedSignatures] of Object.entries(frozenSurface.serviceTags)) {
      expect(serviceTags[tagName]).toEqual(expectedSignatures.map(normalizeSignature).sort());
    }
  });

  test("documents every additive Alpha schema export and service tag", () => {
    const mvpSchemaNames = new Set(frozenSurface.schemaNames);
    const alphaSchemaNames = Object.keys(sdkSchema)
      .filter((schemaName) => !mvpSchemaNames.has(schemaName))
      .sort();

    const mvpServiceTagNames = new Set(Object.keys(frozenSurface.serviceTags));
    const alphaServiceTagNames = Object.keys(currentServiceTagSignatures())
      .filter((tagName) => !mvpServiceTagNames.has(tagName))
      .sort();

    expect(alphaSchemaNames).toEqual(documentedNames("Additive Alpha schema exports"));
    expect(alphaServiceTagNames).toEqual(documentedNames("Additive Alpha service tags"));
  });
});
