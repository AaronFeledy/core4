import { describe, expect, test } from "bun:test";

import {
  VERSION_CONSTRAINT_SKIP_ENV_VAR,
  type VersionConstraintEntry,
  evaluateVersionConstraints,
  isValidSemverRange,
  isVersionConstraintSkipped,
  satisfiesRange,
} from "../../src/config/version-constraint.ts";

describe("satisfiesRange", () => {
  test("plain comparator ranges", () => {
    expect(satisfiesRange("4.2.0", ">=4.1")).toBe(true);
    expect(satisfiesRange("4.0.9", ">=4.1")).toBe(false);
    expect(satisfiesRange("4.2.0", "<5")).toBe(true);
    expect(satisfiesRange("5.0.0", "<5")).toBe(false);
  });

  test("accumulated comparators in one range use AND semantics", () => {
    expect(satisfiesRange("4.3.0", ">=4.1 <5")).toBe(true);
    expect(satisfiesRange("5.1.0", ">=4.1 <5")).toBe(false);
    expect(satisfiesRange("4.0.0", ">=4.1 <5")).toBe(false);
  });

  test("range evaluation includes prereleases (spec 7.4)", () => {
    // A prerelease of a version within the numeric range satisfies the range,
    // so constraints stay useful on dev/next channels.
    expect(satisfiesRange("4.1.0-beta.2", ">=4.1")).toBe(true);
    expect(satisfiesRange("4.1.0-beta.2", ">=4.1 <5")).toBe(true);
    expect(satisfiesRange("4.2.0-alpha.1", ">=4.1 <5")).toBe(true);
  });

  test("caret and tilde ranges", () => {
    expect(satisfiesRange("4.5.0", "^4.1")).toBe(true);
    expect(satisfiesRange("5.0.0", "^4.1")).toBe(false);
    expect(satisfiesRange("4.1.9", "~4.1")).toBe(true);
    expect(satisfiesRange("4.2.0", "~4.1")).toBe(false);
  });

  test("exact and v-prefixed versions", () => {
    expect(satisfiesRange("4.1.0", "=4.1.0")).toBe(true);
    expect(satisfiesRange("4.1.1", "4.1.0")).toBe(false);
    expect(satisfiesRange("4.1.0", "v4.1.0")).toBe(true);
  });
});

describe("isValidSemverRange", () => {
  test("accepts supported forms", () => {
    for (const range of [">=4.1 <5", "^4.0.0", "~4.1", "4.2.0", ">4", "<=4.5.0", "v4.1.0"]) {
      expect(isValidSemverRange(range)).toBe(true);
    }
  });

  test("rejects unparseable and unsupported forms", () => {
    for (const range of ["", "   ", "not-a-range", ">=4.1 || <3", "4.1.0 - 4.5.0", ">=abc", ">=@4"]) {
      expect(isValidSemverRange(range)).toBe(false);
    }
  });
});

describe("evaluateVersionConstraints", () => {
  const entries = (
    ...pairs: ReadonlyArray<readonly [string, string]>
  ): ReadonlyArray<VersionConstraintEntry> => pairs.map(([range, source]) => ({ range, source }));

  test("all satisfied returns no invalid and no unsatisfied", () => {
    const result = evaluateVersionConstraints(entries([">=4.1", ".lando.yml"]), "4.2.0");
    expect(result.invalid).toEqual([]);
    expect(result.unsatisfied).toEqual([]);
  });

  test("constraints accumulate across layers; a looser layer cannot rescue a stricter one", () => {
    // Lower-precedence layer floor >=4.1, higher-precedence layer tightens >=4.5.
    // Running 4.2.0 satisfies the floor but violates the tighter range: reported.
    const result = evaluateVersionConstraints(entries([">=4.1", "base"], [">=4.5", "local"]), "4.2.0");
    expect(result.unsatisfied.map((entry) => entry.source)).toEqual(["local"]);
    expect(result.unsatisfied[0]?.range).toBe(">=4.5");
  });

  test("multiple layers can all be unsatisfied and are all reported with sources", () => {
    const result = evaluateVersionConstraints(entries([">=4.5", "base"], ["<3", "local"]), "4.2.0");
    expect(result.unsatisfied.map((entry) => entry.source)).toEqual(["base", "local"]);
  });

  test("invalid ranges are surfaced separately from unsatisfied ranges", () => {
    const result = evaluateVersionConstraints(entries(["not-a-range", ".lando.yml"]), "4.2.0");
    expect(result.invalid.map((entry) => entry.source)).toEqual([".lando.yml"]);
    expect(result.unsatisfied).toEqual([]);
  });
});

describe("isVersionConstraintSkipped", () => {
  test("env var name is LANDO_SKIP_VERSION_CONSTRAINT", () => {
    expect(VERSION_CONSTRAINT_SKIP_ENV_VAR).toBe("LANDO_SKIP_VERSION_CONSTRAINT");
  });

  test("only the exact value 1 enables the skip", () => {
    expect(isVersionConstraintSkipped({ LANDO_SKIP_VERSION_CONSTRAINT: "1" })).toBe(true);
    expect(isVersionConstraintSkipped({ LANDO_SKIP_VERSION_CONSTRAINT: "0" })).toBe(false);
    expect(isVersionConstraintSkipped({ LANDO_SKIP_VERSION_CONSTRAINT: "true" })).toBe(false);
    expect(isVersionConstraintSkipped({})).toBe(false);
  });
});
