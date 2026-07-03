import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import SetupCommand from "../../src/cli/oclif/commands/meta/setup.ts";
import { COMPILED_OCLIF_MANIFEST } from "../../src/cli/oclif/compiled-manifest.ts";
import { BUNDLED_SETUP_FLAG_CONTRIBUTIONS } from "../../src/cli/oclif/generated/setup-plugin-flags.ts";

const UNIVERSAL_FLAG_NAMES = new Set(["format", "json"]);

describe("meta:setup plugin flag merge", () => {
  test("every bundled contributed flag is merged into SetupCommand.flags metadata", () => {
    const flagNames = new Set(Object.keys(SetupCommand.flags));
    for (const { flag } of BUNDLED_SETUP_FLAG_CONTRIBUTIONS) {
      expect(flagNames.has(flag.name)).toBe(true);
    }
  });

  test("runtime-bundle flags are sourced from the provider contribution, not core built-ins", () => {
    const contributedNames = BUNDLED_SETUP_FLAG_CONTRIBUTIONS.map((c) => c.flag.name);
    expect(contributedNames).toContain("runtime-bundle-url");
    expect(contributedNames).toContain("runtime-bundle-sha256");
    expect(Object.keys(SetupCommand.flags)).toContain("runtime-bundle-url");
    expect(Object.keys(SetupCommand.flags)).toContain("runtime-bundle-sha256");
  });

  test("an unknown flag name is absent from the strict flag surface", () => {
    expect(Object.keys(SetupCommand.flags)).not.toContain("definitely-not-a-setup-flag");
  });

  test("source flag surface matches the compiled manifest (parity)", () => {
    const sourceFlagNames = new Set(Object.keys(SetupCommand.flags));
    const compiledFlagNames = new Set(
      Object.keys(COMPILED_OCLIF_MANIFEST.commands["meta:setup"]?.flags ?? {}).filter(
        (name) => !UNIVERSAL_FLAG_NAMES.has(name),
      ),
    );
    expect([...compiledFlagNames].sort()).toEqual([...sourceFlagNames].sort());
  });

  test("the generated contributions module has no runtime imports (cold-start safe)", () => {
    const generatedPath = resolve(import.meta.dirname, "../../src/cli/oclif/generated/setup-plugin-flags.ts");
    const source = readFileSync(generatedPath, "utf8");
    const importLines = source.split("\n").filter((line) => /^\s*import\b/.test(line));
    expect(importLines.length).toBeGreaterThan(0);
    for (const line of importLines) {
      expect(line.trimStart().startsWith("import type")).toBe(true);
    }
    expect(source).not.toContain('from "@lando/provider-');
  });
});
