import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

const repoRoot = resolve(import.meta.dirname, "../../..");
const rootPackagePath = resolve(repoRoot, "package.json");

const BOUNDARY_RULE_IDS = [
  "renderer-boundary",
  "managed-file-boundary",
  "redaction-boundary",
  "env-helper-boundary",
  "package-dag",
  "paths-boundary",
  "state-store-boundary",
  "probe-boundary",
  "network-boundary",
  "import-cycle",
] as const;

describe("lint script composition", () => {
  test("lint runs biome, architecture, then deprecations in order", async () => {
    const pkg = JSON.parse(await Bun.file(rootPackagePath).text()) as {
      scripts?: Record<string, string>;
    };
    const scripts = pkg.scripts ?? {};
    const lint = scripts.lint ?? "";

    const biomeIdx = lint.indexOf("biome check .");
    const architectureIdx = lint.indexOf("check:architecture");
    const deprecationsIdx = lint.indexOf("check:deprecations");

    expect(biomeIdx, "lint must include biome check .").toBeGreaterThanOrEqual(0);
    expect(architectureIdx, "lint must include check:architecture").toBeGreaterThanOrEqual(0);
    expect(deprecationsIdx, "lint must include check:deprecations").toBeGreaterThanOrEqual(0);
    expect(biomeIdx).toBeLessThan(architectureIdx);
    expect(architectureIdx).toBeLessThan(deprecationsIdx);

    expect(scripts["check:architecture"]).toBe("bun run scripts/check-architecture.ts");

    for (const id of BOUNDARY_RULE_IDS) {
      expect(scripts[`check:${id}`], `missing check:${id} script`).toBeString();
    }
  });
});
