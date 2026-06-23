import { readFile } from "node:fs/promises";

import { describe, expect, test } from "bun:test";

describe("@lando/sdk/verified-stream import boundary", () => {
  test("stays independent of core runtime and OCLIF", async () => {
    const source = await readFile(new URL("../../src/verified-stream/index.ts", import.meta.url), "utf8");
    const importSpecifiers = Array.from(
      source.matchAll(/import(?:\s+type)?[\s\S]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/gu),
      (match) => match[1] ?? match[2],
    );

    expect(importSpecifiers).toEqual(["node:crypto", "node:fs/promises", "node:path", "effect"]);
    expect(source).not.toMatch(/\b(?:Context|Layer|Runtime|ManagedRuntime)\b/u);
  });
});
