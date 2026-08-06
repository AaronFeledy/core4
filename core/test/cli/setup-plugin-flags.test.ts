import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import { COMMAND_REGISTRY_MANIFEST } from "../../src/cli/generated/command-registry-manifest.ts";
import { BUNDLED_SETUP_FLAG_CONTRIBUTIONS } from "../../src/cli/generated/setup-plugin-flags.ts";
import { SETUP_COMMAND_FLAGS } from "../../src/cli/oclif/commands/meta/setup-command-flags.ts";
import SetupCommand from "../../src/cli/oclif/commands/meta/setup.ts";
import { setupSpec } from "../../src/cli/oclif/commands/meta/setup.ts";

const UNIVERSAL_FLAG_NAMES = new Set(["format", "json"]);

describe("meta:setup plugin flag merge", () => {
  test("native spec, legacy wrapper, and manifest share one merged setup flag surface", () => {
    // When
    const manifestFlags = COMMAND_REGISTRY_MANIFEST.commands["meta:setup"]?.spec.flags;

    // Then
    expect(setupSpec.flags).toBe(SETUP_COMMAND_FLAGS);
    expect(SetupCommand.flags).toBe(SETUP_COMMAND_FLAGS);
    expect(JSON.stringify(manifestFlags)).toBe(JSON.stringify(SETUP_COMMAND_FLAGS));
  });

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

  test("source flag surface matches the embedded registry manifest", () => {
    const sourceFlagNames = new Set(Object.keys(SetupCommand.flags));
    const manifestFlagNames = new Set(
      Object.keys(COMMAND_REGISTRY_MANIFEST.commands["meta:setup"]?.flags ?? {}).filter(
        (name) => !UNIVERSAL_FLAG_NAMES.has(name),
      ),
    );
    expect([...manifestFlagNames].sort()).toEqual([...sourceFlagNames].sort());
  });

  test("the generated contributions module has no runtime imports (cold-start safe)", () => {
    const generatedPath = resolve(import.meta.dirname, "../../src/cli/generated/setup-plugin-flags.ts");
    const source = readFileSync(generatedPath, "utf8");
    const importLines = source.split("\n").filter((line) => /^\s*import\b/.test(line));
    expect(importLines.length).toBeGreaterThan(0);
    for (const line of importLines) {
      expect(line.trimStart().startsWith("import type")).toBe(true);
    }
    expect(source).not.toContain('from "@lando/provider-');
  });

  test("generated setup contributions are owned by the native CLI tree", async () => {
    // Given
    const nativePath = resolve(import.meta.dirname, "../../src/cli/generated/setup-plugin-flags.ts");
    const legacyPath = resolve(import.meta.dirname, "../../src/cli/oclif/generated/setup-plugin-flags.ts");

    // When
    const [nativeExists, legacyExists] = await Promise.all([
      Bun.file(nativePath).exists(),
      Bun.file(legacyPath).exists(),
    ]);

    // Then
    expect(nativeExists).toBe(true);
    expect(legacyExists).toBe(false);
  });
});
