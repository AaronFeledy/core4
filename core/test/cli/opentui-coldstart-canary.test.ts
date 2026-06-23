import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..", "..");

const readSource = (relativePath: string): string => readFileSync(join(repoRoot, relativePath), "utf8");

const collectTsFiles = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
};

describe("OpenTUI cold-start canary (S11)", () => {
  test("the renderer plugin entry does not statically import OpenTUI or the prompt driver", () => {
    const index = readSource("plugins/renderer-lando/src/index.ts");
    expect(index).not.toMatch(/import\s[^;]*from\s+["']@opentui\/core["']/);
    expect(index).not.toMatch(/import\s[^;]*from\s+["']\.\/opentui\/prompt-driver/);
    // The driver must be reached through a dynamic import only.
    expect(index).toMatch(/await import\(["']\.\/opentui\/prompt-driver/);
  });

  test("no production renderer-plugin source imports @opentui/core via a literal specifier", () => {
    const srcDir = join(repoRoot, "plugins", "renderer-lando", "src");
    for (const file of collectTsFiles(srcDir)) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toMatch(/from\s+["']@opentui\/core["']/);
      expect(source).not.toMatch(/import\(\s*["']@opentui\/core["']\s*\)/);
    }
  });

  test("the core driver loader reaches the renderer plugin only through a dynamic import", () => {
    const loader = readSource("core/src/interaction/interactive-driver.ts");
    expect(loader).not.toMatch(/import\s[^;]*from\s+["']@lando\/renderer-lando["']/);
    expect(loader).toMatch(/import\(\s*RENDERER_PLUGIN_SPECIFIER\s*\)/);
  });
});
