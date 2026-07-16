import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
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

  test("production source has exactly one lazy literal OpenTUI import", async () => {
    const pluginSrcDirs = readdirSync(join(repoRoot, "plugins"))
      .map((entry) => join(repoRoot, "plugins", entry, "src"))
      .filter((path) => existsSync(path) && statSync(path).isDirectory());
    const productionDirs = [
      join(repoRoot, "core", "bin"),
      join(repoRoot, "core", "src"),
      join(repoRoot, "sdk", "src"),
      join(repoRoot, "container-runtime", "src"),
      ...pluginSrcDirs,
    ];
    const opentuiImports: Array<{ readonly file: string; readonly path: string; readonly kind: string }> = [];
    for (const file of productionDirs.flatMap(collectTsFiles)) {
      const source = readFileSync(file, "utf8");
      const imports = new Bun.Transpiler({ loader: "ts" }).scan(source);
      for (const edge of imports.imports) {
        if (edge.path.startsWith("@opentui/")) {
          opentuiImports.push({ file, path: edge.path, kind: edge.kind });
        }
      }
    }

    expect(opentuiImports).toEqual([
      {
        file: join(repoRoot, "plugins", "renderer-lando", "src", "opentui", "prompt-driver.ts"),
        path: "@opentui/core",
        kind: "dynamic-import",
      },
    ]);
  });

  test("renderer tests may statically import the OpenTUI testing harness", () => {
    const testDir = join(repoRoot, "plugins", "renderer-lando", "test");
    const testingImports = collectTsFiles(testDir).filter((file) =>
      /from\s+["']@opentui\/core\/testing["']/.test(readFileSync(file, "utf8")),
    );

    expect(testingImports.length).toBeGreaterThan(0);
  });

  test("the core driver loader reaches the renderer plugin only through a dynamic import", () => {
    const loader = readSource("core/src/interaction/interactive-driver.ts");
    expect(loader).not.toMatch(/import\s[^;]*from\s+["']@lando\/renderer-lando["']/);
    expect(loader).toMatch(/import\(\s*["']@lando\/renderer-lando["']\s*\)/);
    expect(loader).not.toMatch(/import\(\s*[A-Za-z_$][\w$]*\s*\)/);
  });
});
