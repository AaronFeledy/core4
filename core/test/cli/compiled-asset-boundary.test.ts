import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

const repoRoot = resolve(import.meta.dirname, "../../..");

const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");

const compiledRuntimeAssetModules = [
  "core/src/cli/run.ts",
  "core/src/cli/compiled-argv.ts",
  "core/src/cli/compiled-normalize.ts",
  "core/src/cli/compiled-runtime.ts",
  "core/src/cli/compiled-input.ts",
  "core/src/cli/cli-help.ts",
  "core/src/cli/cli-adapters/app-lifecycle.ts",
  "core/src/cli/cli-adapters/exec-shell.ts",
  "core/src/cli/cli-adapters/meta-plugin.ts",
  "core/src/cli/oclif/manifest.ts",
  "core/src/cli/oclif/compiled-manifest.ts",
  "core/src/recipes/bundled.ts",
  "sdk/src/schema/json-schema.ts",
] as const;

describe("compiled binary asset boundary", () => {
  test("runtime modules embed assets instead of reading generated asset files from disk", async () => {
    for (const relativePath of compiledRuntimeAssetModules) {
      const source = stripComments(await readFile(resolve(repoRoot, relativePath), "utf8"));

      expect(source, `${relativePath} must not import runtime filesystem readers`).not.toMatch(
        /from\s+["']node:fs|from\s+["']node:fs\/promises|Bun\.file|readFileSync|readFile\(/u,
      );
      expect(source, `${relativePath} must not path-reference generated asset files at runtime`).not.toMatch(
        /recipes\/|sdk\/schema\/|oclif\.manifest\.json/u,
      );
    }
  });
});
