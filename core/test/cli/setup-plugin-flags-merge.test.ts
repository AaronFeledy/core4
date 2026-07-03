import { describe, expect, test } from "bun:test";

import type { BundledSetupFlagContribution } from "../../src/cli/oclif/generated/setup-plugin-flags.ts";
import {
  SetupFlagCollisionError,
  mergeSetupPluginFlags,
} from "../../src/cli/oclif/setup-plugin-flags-merge.ts";

const BUILT_IN_NAMES = ["yes", "no-interactive", "provider", "skip-provider", "host-proxy"] as const;

const optionContribution = (
  plugin: string,
  name: string,
  extra: Partial<BundledSetupFlagContribution["flag"]> = {},
): BundledSetupFlagContribution => ({
  plugin,
  providers: ["demo"],
  flag: { name, type: "option", ...extra },
});

const booleanContribution = (plugin: string, name: string): BundledSetupFlagContribution => ({
  plugin,
  providers: ["demo"],
  flag: { name, type: "boolean" },
});

describe("mergeSetupPluginFlags", () => {
  test("merges an option contribution into an oclif option flag with description and options", () => {
    const merged = mergeSetupPluginFlags(BUILT_IN_NAMES, [
      optionContribution("@lando/demo", "demo-mode", {
        description: "Pick a demo mode.",
        options: ["fast", "slow"],
      }),
    ]);

    const flag = merged.flags["demo-mode"];
    expect(flag).toBeDefined();
    expect(flag?.type).toBe("option");
    expect(flag?.description).toBe("Pick a demo mode.");
    expect((flag as { options?: readonly string[] }).options).toEqual(["fast", "slow"]);
    expect(merged.ownership.get("demo-mode")).toBe("@lando/demo");
  });

  test("merges a boolean contribution into an oclif boolean flag", () => {
    const merged = mergeSetupPluginFlags(BUILT_IN_NAMES, [booleanContribution("@lando/demo", "demo-toggle")]);
    expect(merged.flags["demo-toggle"]?.type).toBe("boolean");
  });

  test("collision with a built-in flag throws a tagged SetupFlagCollisionError", () => {
    let caught: unknown;
    try {
      mergeSetupPluginFlags(BUILT_IN_NAMES, [optionContribution("@lando/demo", "provider")]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SetupFlagCollisionError);
    const error = caught as SetupFlagCollisionError;
    expect(error._tag).toBe("SetupFlagCollisionError");
    expect(error.flagName).toBe("provider");
    expect(error.pluginName).toBe("@lando/demo");
    expect(error.conflictsWith).toBe("built-in");
    expect(error.remediation.length).toBeGreaterThan(0);
  });

  test("collision between two plugins throws a tagged SetupFlagCollisionError naming the prior owner", () => {
    let caught: unknown;
    try {
      mergeSetupPluginFlags(BUILT_IN_NAMES, [
        optionContribution("@lando/first", "shared-flag"),
        optionContribution("@lando/second", "shared-flag"),
      ]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SetupFlagCollisionError);
    const error = caught as SetupFlagCollisionError;
    expect(error.flagName).toBe("shared-flag");
    expect(error.pluginName).toBe("@lando/second");
    expect(error.conflictsWith).toBe("@lando/first");
  });

  test("empty contributions yield an empty flag map", () => {
    const merged = mergeSetupPluginFlags(BUILT_IN_NAMES, []);
    expect(Object.keys(merged.flags)).toHaveLength(0);
    expect(merged.ownership.size).toBe(0);
  });
});
