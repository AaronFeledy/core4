import { describe, expect, test } from "bun:test";

const EXPECTED_RUNTIME_EXPORTS = [
  "AppPlanner",
  "AppPlannerLive",
  "DEFAULT_PROXY_DOMAIN",
  "FILE_SYNC_DEFAULT_EXCLUDES",
  "applyAuthoredAppMount",
  "applyAuthoredDependencies",
  "applyAuthoredHealthcheck",
  "mergeDefaultExcludes",
] as const;

const REQUIRED_MODULES = [
  "assemble.ts",
  "authored.ts",
  "compose-capabilities.ts",
  "endpoints.ts",
  "extensions.ts",
  "file-sync.ts",
  "naming.ts",
  "service-types.ts",
  "storage.ts",
] as const;

const plannerRoot = new URL("../src/planner/", import.meta.url);

describe("@lando/engine planner module boundaries", () => {
  test("exposes exactly the locked planner facade exports", async () => {
    // Given: the stable service facade contract
    const expected = [...EXPECTED_RUNTIME_EXPORTS].sort();

    // When: the service facade is loaded
    const module: Record<string, unknown> = await import("@lando/engine/services/planner");
    const actual = Object.keys(module).sort();

    // Then: no internal planner symbols leak through the facade
    expect(actual).toEqual(expected);
  });

  test("owns the required bounded concern modules with planApp in assemble", async () => {
    // Given: the required planner concern ownership contract
    const modules = [...new Bun.Glob("*.ts").scanSync({ cwd: plannerRoot.pathname })].sort();

    // When: every planner module is inspected
    const sources = await Promise.all(
      modules.map(async (module) => [module, await Bun.file(new URL(module, plannerRoot)).text()] as const),
    );

    // Then: all required modules exist, stay bounded, and assemble owns planApp
    expect(modules).toEqual(expect.arrayContaining(REQUIRED_MODULES));
    expect(sources.map(([module, source]) => [module, source.split("\n").length - 1])).toEqual(
      expect.arrayContaining(modules.map((module) => [module, expect.any(Number)])),
    );
    for (const [module, source] of sources) {
      expect(source.split("\n").length - 1, `${module} exceeds 600 lines`).toBeLessThanOrEqual(600);
      expect(source, `${module} imports the planner service facade`).not.toMatch(/services\/planner/u);
    }
    expect(sources.find(([module]) => module === "assemble.ts")?.[1]).toMatch(/const planApp\s*=/u);
  });
});
