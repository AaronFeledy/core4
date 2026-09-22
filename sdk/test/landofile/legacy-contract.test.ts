import { describe, expect, test } from "bun:test";

import { LEGACY_TAGGED, isLegacyTagged, makeLegacyTagged } from "../../src/landofile/legacy/contract.ts";
import { legacyParseError } from "../../src/landofile/legacy/errors.ts";
import {
  DEFAULT_MAX_ALIASES,
  DEFAULT_MAX_CONTENT_BYTES,
  DEFAULT_MAX_DEPTH,
  MIN_EXPANSION_BUDGET,
  assertLegacyContentSize,
  expansionBudget,
  resolveLegacyLimits,
} from "../../src/landofile/legacy/limits.ts";

const span = {
  start: { line: 1, column: 1, offset: 0 },
  end: { line: 1, column: 2, offset: 1 },
};

describe("legacy parse contract", () => {
  test("tagged markers are recognized and plain values are not", () => {
    const tagged = makeLegacyTagged("!load", "scripts/build.sh", span);

    expect(isLegacyTagged(tagged)).toBe(true);
    expect(tagged[LEGACY_TAGGED]).toBe(true);
    expect(tagged.tag).toBe("!load");
    expect(tagged.value).toBe("scripts/build.sh");
    expect(tagged.span).toEqual(span);

    expect(isLegacyTagged({ tag: "!load", value: "x" })).toBe(false);
    expect(isLegacyTagged(null)).toBe(false);
    expect(isLegacyTagged("!load")).toBe(false);
    expect(isLegacyTagged(undefined)).toBe(false);
  });

  test("limits fall back to the documented defaults", () => {
    expect(resolveLegacyLimits()).toEqual({
      maxContentBytes: DEFAULT_MAX_CONTENT_BYTES,
      maxDepth: DEFAULT_MAX_DEPTH,
      maxAliases: DEFAULT_MAX_ALIASES,
    });
    expect(DEFAULT_MAX_CONTENT_BYTES).toBe(1024 * 1024);
    expect(DEFAULT_MAX_DEPTH).toBe(64);
    expect(DEFAULT_MAX_ALIASES).toBe(1000);
  });

  test("supplied limits override one field at a time", () => {
    expect(resolveLegacyLimits({ maxAliases: 3 })).toEqual({
      maxContentBytes: DEFAULT_MAX_CONTENT_BYTES,
      maxDepth: DEFAULT_MAX_DEPTH,
      maxAliases: 3,
    });
    expect(resolveLegacyLimits({ maxContentBytes: 10, maxDepth: 2 })).toEqual({
      maxContentBytes: 10,
      maxDepth: 2,
      maxAliases: DEFAULT_MAX_ALIASES,
    });
  });

  test("the content cap counts utf-8 bytes, not characters", () => {
    // "é" is two bytes, so four characters are five bytes.
    const content = "abcé";

    expect(() => {
      assertLegacyContentSize(content, "/app/.lando.yml", 5);
    }).not.toThrow();

    expect(() => {
      assertLegacyContentSize(content, "/app/.lando.yml", 4);
    }).toThrow(/exceeds the maximum input size: 5 bytes > 4 bytes/);
  });

  test("the alias expansion budget never rejects an alias-free document", () => {
    expect(expansionBudget(10)).toBe(MIN_EXPANSION_BUDGET);
    expect(expansionBudget(MIN_EXPANSION_BUDGET + 7)).toBe(MIN_EXPANSION_BUDGET + 7);
  });

  test("legacy failures are tagged Landofile parse errors with remediation", () => {
    const error = legacyParseError(
      "/app/.lando.yml",
      "Duplicate mapping key services.",
      { line: 7, column: 3 },
      "Remove one of the duplicate keys.",
    );

    expect(error._tag).toBe("LandofileParseError");
    expect(error.filePath).toBe("/app/.lando.yml");
    expect(error.line).toBe(7);
    expect(error.column).toBe(3);
    expect(error.remediation).toBe("Remove one of the duplicate keys.");
  });
});
