import { readFile } from "node:fs/promises";

import { describe, expect, test } from "bun:test";

const importSpecifiersOf = (source: string): string[] =>
  Array.from(
    source.matchAll(/import(?:\s+type)?[\s\S]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/gu),
    (match) => match[1] ?? match[2],
  ).filter((value): value is string => value !== undefined);

describe("@lando/sdk/secrets import boundary", () => {
  test("the profiles primitive imports only the sibling value redactor", async () => {
    const source = await readFile(new URL("../../src/secrets/redactor-profiles.ts", import.meta.url), "utf8");
    const specifiers = importSpecifiersOf(source);

    // Pure primitive: the only permitted import is the same-subpath value layer.
    expect(specifiers).toEqual(["./redactor.ts"]);
  });

  test("stays free of Effect runtime, Node/Bun IO, and core internals", async () => {
    for (const file of [
      "../../src/secrets/index.ts",
      "../../src/secrets/redactor-profiles.ts",
      "../../src/secrets/redactor.ts",
    ]) {
      const source = await readFile(new URL(file, import.meta.url), "utf8");
      const specifiers = importSpecifiersOf(source);

      for (const specifier of specifiers) {
        expect(specifier.startsWith("node:")).toBe(false);
        expect(specifier.startsWith("bun:")).toBe(false);
        expect(specifier).not.toBe("effect");
        expect(specifier.startsWith("@lando/core")).toBe(false);
        expect(specifier.startsWith("@lando/sdk")).toBe(false);
      }

      expect(source).not.toMatch(/\b(?:Context|Layer|Runtime|ManagedRuntime)\b/u);
    }
  });
});
