import { describe, expect, test } from "bun:test";

import type { PluginManifest } from "@lando/sdk/schema";

import SetupCommand from "../../src/cli/oclif/commands/meta/setup.ts";
import { BUNDLED_SETUP_FLAG_CONTRIBUTIONS } from "../../src/cli/oclif/generated/setup-plugin-flags.ts";
import {
  SETUP_BUILTIN_FLAG_NAMES,
  SetupFlagCollisionError,
  findSetupFlagCollision,
  manifestSetupFlagContributions,
} from "../../src/plugins/setup-flags.ts";

const manifest = (name: string, flagNames: ReadonlyArray<string>): PluginManifest =>
  ({
    name,
    version: "1.0.0",
    api: 4,
    contributes: { setup: { flags: flagNames.map((flagName) => ({ name: flagName, type: "boolean" })) } },
  }) as unknown as PluginManifest;

describe("findSetupFlagCollision", () => {
  test("returns undefined when no name collides", () => {
    const result = findSetupFlagCollision(SETUP_BUILTIN_FLAG_NAMES, [
      { plugin: "@lando/demo", flagName: "demo-flag" },
    ]);
    expect(result).toBeUndefined();
  });

  test("flags a collision with a built-in flag name", () => {
    const result = findSetupFlagCollision(SETUP_BUILTIN_FLAG_NAMES, [
      { plugin: "@lando/demo", flagName: "provider" },
    ]);
    expect(result).toBeInstanceOf(SetupFlagCollisionError);
    expect(result?.conflictsWith).toBe("built-in");
    expect(result?.flagName).toBe("provider");
  });

  test("flags a collision between two plugins naming the prior owner", () => {
    const result = findSetupFlagCollision(SETUP_BUILTIN_FLAG_NAMES, [
      { plugin: "@lando/first", flagName: "shared" },
      { plugin: "@lando/second", flagName: "shared" },
    ]);
    expect(result?.pluginName).toBe("@lando/second");
    expect(result?.conflictsWith).toBe("@lando/first");
  });
});

describe("manifestSetupFlagContributions", () => {
  test("extracts contributed setup flags across manifests", () => {
    const contributions = manifestSetupFlagContributions([
      manifest("@lando/a", ["a-one", "a-two"]),
      manifest("@lando/b", ["b-one"]),
    ]);
    expect(contributions).toEqual([
      { plugin: "@lando/a", flagName: "a-one" },
      { plugin: "@lando/a", flagName: "a-two" },
      { plugin: "@lando/b", flagName: "b-one" },
    ]);
  });
});

describe("SETUP_BUILTIN_FLAG_NAMES drift guard", () => {
  test("covers every non-contributed SetupCommand flag plus the universal flags", () => {
    const reserved = new Set(SETUP_BUILTIN_FLAG_NAMES);
    const contributed = new Set(BUNDLED_SETUP_FLAG_CONTRIBUTIONS.map((c) => c.flag.name));
    for (const name of Object.keys(SetupCommand.flags)) {
      if (contributed.has(name)) continue;
      expect(reserved.has(name)).toBe(true);
    }
    expect(reserved.has("format")).toBe(true);
    expect(reserved.has("json")).toBe(true);
  });
});
