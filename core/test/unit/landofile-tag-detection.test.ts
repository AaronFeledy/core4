import { describe, expect, test } from "bun:test";

import { Effect } from "effect";

import { LandofileParseError } from "@lando/sdk/errors";
import { detectLandofileTags, parseLandofile } from "@lando/sdk/landofile";

const detect = (content: string) => detectLandofileTags({ content, file: "/workspace/.lando.yml" });

describe("detectLandofileTags", () => {
  const matchingCases = [
    ["map reset", "environment: !reset", "!reset", 1, 14],
    ["reset with empty list", "ports: !reset []", "!reset", 1, 8],
    ["reset with null", "env_file: !reset null", "!reset", 1, 11],
    ["sequence reset", "values:\n  - !reset", "!reset", 2, 5],
    ["override with list", "ports: !override [80]", "!override", 1, 8],
    ["override with empty object", "environment: !override {}", "!override", 1, 14],
    ["bare override", "x: !override", "!override", 1, 4],
    ["merge-key reset", "<<: !reset", "!reset", 1, 5],
    ["sequence merge-key reset", "values:\n  - <<: !reset", "!reset", 2, 9],
    ["anchored reset", "ports: &shared !reset", "!reset", 1, 16],
    ["anchored override in a sequence", "values:\n  - &shared !override", "!override", 2, 13],
    ["anchored reset in an inline list", "ports: &shared [!reset]", "!reset", 1, 17],
    ["reset behind a punctuated anchor name", "ports: &shared.default !reset", "!reset", 1, 24],
  ] as const;

  for (const [name, content, tag, line, column] of matchingCases) {
    test(`finds ${name} in a YAML value position`, () => {
      // Given
      const source = content;

      // When
      const occurrences = detect(source);

      // Then
      expect(occurrences).toEqual([{ tag, line, column }]);
    });
  }

  test("finds override before parsing rejects its populated inline object", () => {
    // Given
    const content = "environment: !override {A: 1}";

    // When
    const occurrences = detect(content);

    // Then
    expect(occurrences).toEqual([{ tag: "!override", line: 1, column: 14 }]);
  });

  test("finds tags in items produced by the inline-array splitter", () => {
    // Given
    const content = "x: [plain, !reset]";

    // When
    const occurrences = detect(content);

    // Then
    expect(occurrences).toEqual([{ tag: "!reset", line: 1, column: 12 }]);
  });

  const ignoredCases = [
    ["double-quoted reset literal", 'command: "!reset"'],
    ["single-quoted override literal", "entrypoint: '!override'"],
    ["quoted shell negation", 'command: "! test -e /tmp/x"'],
    ["longer reset-prefixed token", "x: !resettable"],
    ["non-leading reset token", "x: echo !reset"],
    ["whole-line comment", "# !reset"],
    ["trailing comment", "x: value # !override"],
    ["different local tag", "x: !important"],
    ["map key", "reset:"],
  ] as const;

  for (const [name, content] of ignoredCases) {
    test(`ignores ${name}`, () => {
      // Given
      const source = content;

      // When
      const occurrences = detect(source);

      // Then
      expect(occurrences).toEqual([]);
    });
  }

  test("does not treat unsupported anchors or aliases as disposition tags", () => {
    // These forms are NOT supported by this parser; this test does NOT claim they work.
    // Given
    const content = "x: &anchor v\ny: *anchor";

    // When
    const occurrences = detect(content);

    // Then
    expect(occurrences).toEqual([]);
  });

  test("does not treat an invalid merge target as a tag and parsing still rejects it", () => {
    // Given
    const content = "base: &base value\n<<: *base";

    // When
    const occurrences = detect(content);
    const error = Effect.runSync(
      Effect.flip(parseLandofile({ content, file: "/workspace/.lando.yml", cwd: "/workspace" })),
    );

    // Then
    expect(occurrences).toEqual([]);
    expect(error._tag).toBe("LandofileParseError");
    expect(error.message).toMatch(/YAML merge target must be a mapping/);
    expect(error.remediation).toMatch(/anchor|alias|mapping/i);
  });

  test("throws LandofileParseError for tabs instead of returning occurrences", () => {
    // Given
    const content = "x:\t!reset";

    // When / Then
    expect(() => detect(content)).toThrow(/Tabs are not supported in Landofiles/);
    try {
      detect(content);
    } catch (error) {
      expect(error).toBeInstanceOf(LandofileParseError);
      if (!(error instanceof LandofileParseError)) throw error;
      expect(error).toMatchObject({ _tag: "LandofileParseError" });
    }
  });
});
