import { describe, expect, test } from "bun:test";

import { initFileKind, planInitWrites } from "../../src/cli/commands/init-write-plan.ts";

describe("initFileKind", () => {
  test("classifies Landofile layer dests", () => {
    expect(initFileKind(".lando.yml")).toBe("landofile");
    expect(initFileKind(".lando.yaml")).toBe("landofile");
    expect(initFileKind(".lando.ts")).toBe("landofile");
    expect(initFileKind(".lando.local.yml")).toBe("landofile");
    expect(initFileKind("config/.lando.yml")).toBe("landofile");
  });

  test("classifies everything else as scaffold", () => {
    expect(initFileKind("package.json")).toBe("scaffold");
    expect(initFileKind("server.js")).toBe("scaffold");
    expect(initFileKind("README.md")).toBe("scaffold");
  });
});

describe("planInitWrites", () => {
  test("writes every dest when the target is empty", () => {
    expect(planInitWrites([".lando.yml", "package.json", "server.js"], new Set())).toEqual({
      write: [".lando.yml", "package.json", "server.js"],
      skippedScaffold: [],
      landofileConflict: undefined,
    });
  });

  test("writes a free Landofile beside unrelated existing files", () => {
    expect(planInitWrites([".lando.yml"], new Set(["README.md", "src"]))).toEqual({
      write: [".lando.yml"],
      skippedScaffold: [],
      landofileConflict: undefined,
    });
  });

  test("fails closed when the Landofile dest already exists", () => {
    expect(planInitWrites([".lando.yml", "package.json"], new Set([".lando.yml"]))).toEqual({
      write: [],
      skippedScaffold: [],
      landofileConflict: ".lando.yml",
    });
  });

  test("skips the entire scaffold set when any scaffold dest exists", () => {
    expect(planInitWrites([".lando.yml", "package.json", "server.js"], new Set(["package.json"]))).toEqual({
      write: [".lando.yml"],
      skippedScaffold: ["package.json", "server.js"],
      landofileConflict: undefined,
    });
  });

  test("prefers a Landofile conflict over a scaffold skip", () => {
    expect(planInitWrites([".lando.yml", "package.json"], new Set([".lando.yml", "package.json"]))).toEqual({
      write: [],
      skippedScaffold: [],
      landofileConflict: ".lando.yml",
    });
  });
});
