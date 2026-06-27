import { readFile } from "node:fs/promises";

import { describe, expect, test } from "bun:test";

const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/(^|[^:])\/\/[^\n]*/gu, "$1");

const importSpecifiersOf = (source: string): string[] =>
  Array.from(
    source.matchAll(/import(?:\s+type)?[\s\S]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/gu),
    (match) => match[1] ?? match[2],
  ).filter((value): value is string => value !== undefined);

describe("@lando/sdk/probe import boundary", () => {
  test("imports only effect plus type-only sibling schema, never core or IO", async () => {
    const source = await readFile(new URL("../../src/probe/index.ts", import.meta.url), "utf8");
    const specifiers = importSpecifiersOf(source);

    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      const permitted = specifier === "effect" || specifier.startsWith("../schema");
      expect(permitted).toBe(true);
      expect(specifier.startsWith("node:")).toBe(false);
      expect(specifier.startsWith("bun:")).toBe(false);
      expect(specifier.startsWith("@lando/core")).toBe(false);
      expect(specifier.startsWith("@lando/sdk")).toBe(false);
    }
  });

  test("constructs no LandoRuntime, Layer, or service Context in executable code", async () => {
    const source = await readFile(new URL("../../src/probe/index.ts", import.meta.url), "utf8");
    const code = stripComments(source);

    expect(code).not.toMatch(/\bLandoRuntime\b/u);
    expect(code).not.toMatch(/\b(?:Layer|Context|ManagedRuntime)\b/u);
    expect(code).not.toMatch(/\bConsole\.|\bLogger\b/u);
  });
});
