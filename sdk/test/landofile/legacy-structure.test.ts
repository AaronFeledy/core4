import { describe, expect, test } from "bun:test";

import { LandofileParseError } from "../../src/errors/index.ts";
import { resolveLegacyLimits } from "../../src/landofile/legacy/limits.ts";
import { parseLegacyTree } from "../../src/landofile/legacy/parse.ts";

describe("legacy tree — structural boundaries", () => {
  for (const content of ["", "# comment\n\n", "---\n# comment"]) {
    test(`returns no root for ${JSON.stringify(content)}`, () => {
      // Given / When
      const tree = parseLegacyTree(content, "empty.yml", resolveLegacyLimits());
      // Then
      expect(tree.root).toBeNull();
      expect(tree.aliasCount).toBe(0);
      expect(tree.anchors.size).toBe(0);
    });
  }
  test("accepts one leading document marker", () => {
    // Given / When
    const tree = parseLegacyTree("# comment\n--- # header\na: b", "one.yml", resolveLegacyLimits());
    // Then
    expect(tree.root).toMatchObject({ kind: "mapping", span: { start: { line: 3, column: 1, offset: 23 } } });
  });

  const rejections = [
    ["a: 1\na: 2", /Duplicate.*a.*1.*2/, 2, 1],
    ['1: a\n"1": b', /Duplicate.*1.*1.*2/, 2, 1],
    ["{a: 1, a: 2}", /Duplicate.*a/, 1, 8],
    ["- a: 1\n  a: 2", /Duplicate.*a/, 2, 3],
    ["a: &x 1\nb: &x 2", /Duplicate YAML anchor &x\./, 2, 4],
    ["a: *missing", /Unknown YAML alias \*missing\./, 1, 4],
    ["a: *x\nb: &x 1", /Unknown YAML alias \*x\./, 1, 4],
    ["a:\n\tb: c", /[Tt]ab/, 2, 1],
    ["a:\n  \tb: c", /[Tt]ab/, 2, 3],
    ["---\na: b\n---\nc: d", /document/, 3, 1],
    ["a: b\n...", /document/, 2, 1],
    ["%YAML 1.2\na: b", /directive/, 1, 1],
    ["%TAG !x! example\na: b", /directive/, 1, 1],
    ["[a: b]", /[Ss]ingle-pair/, 1, 3],
    ['["a": b]', /[Ss]ingle-pair/, 1, 5],
    ["? complex\n: value", /[Cc]omplex key/, 1, 1],
    ["{? complex: value}", /[Cc]omplex key/, 1, 2],
    ["a: b\n  c: d", /indentation/, 2, 3],
    ["a:\n  b: c\n d: e", /indentation/, 3, 2],
    ["a: b\nbroken", /mapping/, 2, 1],
    ["[a, b", /[Ff]low/, 1, 6],
    ["{a: b]", /[Ff]low/, 1, 6],
    ["a: 'b' extra", /[Uu]nexpected/, 1, 8],
    ["a: &", /reference name/, 1, 5],
    ["a: &x 1\nb: [&x 2]", /Duplicate YAML anchor &x\./, 2, 5],
    ["{a: *x, b: &x 1}", /Unknown YAML alias \*x\./, 1, 5],
  ] as const;
  for (const [content, message, line, column] of rejections) {
    test(`rejects ${JSON.stringify(content)} with source remediation`, () => {
      // Given / When
      let failure: unknown;
      try {
        parseLegacyTree(content, "bad.yml", resolveLegacyLimits());
      } catch (cause) {
        failure = cause;
      }
      // Then
      expect(failure).toBeInstanceOf(LandofileParseError);
      if (!(failure instanceof LandofileParseError)) throw new Error("Expected parse failure");
      expect(failure.message).toMatch(message);
      expect(failure.line).toBe(line);
      expect(failure.column).toBe(column);
      expect(failure.remediation?.length).toBeGreaterThan(10);
    });
  }

  for (const content of ["a:\n  b:\n    c: d", "[[[x]]]", "a:\n  b: [[x]]"]) {
    test(`bounds shared block/flow depth for ${JSON.stringify(content)}`, () => {
      // Given
      const limits = resolveLegacyLimits({ maxDepth: 2 });
      // When / Then
      expect(() => parseLegacyTree(content, "deep.yml", limits)).toThrow(/maximum depth/);
    });
  }
  test("uses bytes for the input cap before inspecting syntax", () => {
    // Given
    const content = "é🚀";
    // When / Then
    expect(() => parseLegacyTree(content, "bytes.yml", resolveLegacyLimits({ maxContentBytes: 5 }))).toThrow(
      /6 bytes > 5 bytes/,
    );
  });
  test("alias span covers only its reference token", () => {
    // Given / When
    const content = "a: &x v\nb: *x # note";
    const { root } = parseLegacyTree(content, "alias.yml", resolveLegacyLimits());
    // Then
    if (root?.kind !== "mapping") throw new Error("Expected mapping");
    const value = root.entries[1]?.value;
    expect(value).toMatchObject({ kind: "alias", name: "x" });
    expect(content.slice(value?.span.start.offset, value?.span.end.offset)).toBe("*x");
  });
  test("accepts an input exactly at its UTF-8 byte cap", () => {
    // Given / When
    const tree = parseLegacyTree("é🚀", "bytes.yml", resolveLegacyLimits({ maxContentBytes: 6 }));
    // Then
    expect(tree.root).toMatchObject({ text: "é🚀", span: { end: { offset: 3, column: 4 } } });
  });
});
