import { describe, expect, test } from "bun:test";

import { resolveLegacyLimits } from "../../src/landofile/legacy/limits.ts";
import { parseLegacyTree } from "../../src/landofile/legacy/parse.ts";

describe("legacy tree — decoded scalar text", () => {
  const cases = [
    ["echo \"hi\" 'there' > ${VAR}#hash # comment", "plain", "echo \"hi\" 'there' > ${VAR}#hash"],
    ["8080:80", "plain", "8080:80"],
    ["https://example.test/a#fragment", "plain", "https://example.test/a#fragment"],
    ["true", "plain", "true"],
    ["null", "plain", "null"],
    ["123", "plain", "123"],
    ["'it''s \\n # literal'", "single", "it's \\n # literal"],
    ['"a # b" # comment', "double", "a # b"],
    [
      '"\\\\\\"\\/\\n\\r\\t\\b\\f\\0\\a\\v\\e\\N\\_\\L\\P"',
      "double",
      '\\"/\n\r\t\b\f\0\x07\v\x1b\u0085\u00a0\u2028\u2029',
    ],
    ['"\\x41\\u00e9\\U0001F680"', "double", "Aé🚀"],
    ["'one\n  two\n\n  three'", "single", "one two\nthree"],
    ['"one\n  two\n\n  three"', "double", "one two\nthree"],
    ['"one\\\n  two"', "double", "onetwo"],
    ['"one\t two"', "double", "one\t two"],
    ["|\n  one\n  two\n\n", "literal", "one\ntwo\n"],
    ["|-\n  one\n\n", "literal", "one"],
    ["|+\n  one\n\n", "literal", "one\n\n"],
    ["|2- # header\n  one\n", "literal", "one"],
    ["|-2 # header\n  one\n", "literal", "one"],
    [">\n  one\n  two\n\n  three\n", "folded", "one two\nthree\n"],
    [">-\n  one\n    indented\n  two\n", "folded", "one\n  indented\ntwo"],
    [">+\n  one\n\n\n", "folded", "one\n\n\n"],
    ["|\n\n    first\n    \tsecond\n", "literal", "\nfirst\n\tsecond\n"],
    ["|", "literal", ""],
    ["|\n  last", "literal", "last"],
    ["|2+\n  one\n    \n", "literal", "one\n  \n"],
    ["|2\n  \t\n", "literal", "\t\n"],
    ['"one\\\n\n  two"', "double", "one\ntwo"],
    ["'one\r\n  two'", "single", "one two"],
    [">2-\n  one\n  two\n", "folded", "one two"],
    [">-2\n  one\n  two\n", "folded", "one two"],
  ] as const;
  for (const [content, style, text] of cases) {
    test(`decodes ${JSON.stringify(content)} without typing`, () => {
      // Given / When
      const tree = parseLegacyTree(content, "scalar.yml", resolveLegacyLimits());
      // Then
      expect(tree.root).toMatchObject({ kind: "scalar", style, text });
    });
  }

  for (let digit = 1; digit <= 9; digit += 1) {
    test(`honors explicit indentation ${digit} below a mapping key`, () => {
      // Given
      const content = `key: |${digit}-\n${" ".repeat(digit)}value\n`;
      // When
      const { root } = parseLegacyTree(content, "indent.yml", resolveLegacyLimits());
      // Then
      if (root?.kind !== "mapping") throw new Error("Expected mapping");
      expect(root.entries[0]?.value).toMatchObject({ style: "literal", text: "value" });
    });
  }

  test("preserves UTF-16 source offsets independently of UTF-8 bytes", () => {
    // Given
    const content = 'é: "🚀" # note\r\nz: last\r\n';
    // When
    const { root } = parseLegacyTree(content, "unicode.yml", resolveLegacyLimits());
    // Then
    expect(root?.kind).toBe("mapping");
    if (root?.kind !== "mapping") throw new Error("Expected mapping");
    const value = root.entries[0]?.value;
    expect(value?.span).toEqual({
      start: { line: 1, column: 4, offset: 3 },
      end: { line: 1, column: 8, offset: 7 },
    });
    expect(content.slice(value?.span.start.offset, value?.span.end.offset)).toBe('"🚀"');
    expect(root.entries[1]?.key.span.start).toEqual({ line: 2, column: 1, offset: 16 });
  });

  for (const content of [
    '"\\q"',
    '"\\xZZ"',
    '"\\u123"',
    '"\\U00110000"',
    '"unclosed',
    "'unclosed",
    "|0\n  a",
    "|--\n  a",
    "|2x\n  a",
  ]) {
    test(`rejects malformed scalar ${JSON.stringify(content)}`, () => {
      // Given / When / Then
      expect(() => parseLegacyTree(content, "bad.yml", resolveLegacyLimits())).toThrow();
    });
  }
});
