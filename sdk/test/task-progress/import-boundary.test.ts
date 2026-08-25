import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/(^|[^:])\/\/[^\n]*/gu, "$1");

const importSpecifiersOf = (source: string): string[] =>
  Array.from(
    source.matchAll(/import(?:\s+type)?[\s\S]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/gu),
    (match) => match[1] ?? match[2],
  ).filter((value): value is string => value !== undefined);

const taskProgressDir = new URL("../../src/task-progress", import.meta.url);

describe("@lando/sdk/task-progress import boundary", () => {
  test("imports only effect plus type-only sibling events/schema/services, never core or IO", async () => {
    const files = (await readdir(taskProgressDir)).filter((name) => name.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);

    const specifiers: string[] = [];
    for (const name of files) {
      const source = await readFile(join(taskProgressDir.pathname, name), "utf8");
      specifiers.push(...importSpecifiersOf(source));
    }

    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      const permitted =
        specifier === "effect" ||
        specifier.startsWith("../events") ||
        specifier.startsWith("../schema") ||
        specifier.startsWith("../services") ||
        specifier.startsWith("./");
      expect(permitted).toBe(true);
      expect(specifier.startsWith("node:")).toBe(false);
      expect(specifier.startsWith("bun:")).toBe(false);
      expect(specifier.startsWith("@lando/core")).toBe(false);
      expect(specifier.startsWith("@lando/sdk")).toBe(false);
    }
  });

  test("constructs no LandoRuntime, Layer, or service Context in executable code", async () => {
    const files = (await readdir(taskProgressDir)).filter((name) => name.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);

    for (const name of files) {
      const source = await readFile(join(taskProgressDir.pathname, name), "utf8");
      const code = stripComments(source);
      expect(code).not.toMatch(/\bLandoRuntime\b/u);
      expect(code).not.toMatch(/\b(?:Layer|Context|ManagedRuntime)\b/u);
      expect(code).not.toMatch(/\bConsole\.|\bLogger\b/u);
    }
  });
});
