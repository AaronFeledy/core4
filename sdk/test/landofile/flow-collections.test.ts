import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { parseLandofile, parseLegacyLandofile } from "@lando/sdk/landofile";

const file = "/app/.lando.yml";
const mappings = [
  { text: "[{a: 1, b: 2}, {c: 3}]", value: [{ a: 1, b: 2 }, { c: 3 }], column: 9 },
  { text: "{a: [1, 2]}", value: { a: [1, 2] }, column: 8 },
  { text: "[{a: [1, 2], b: [3, 4]}]", value: [{ a: [1, 2], b: [3, 4] }], column: 9 },
  { text: "[[{a: 1, b: 2}]]", value: [[{ a: 1, b: 2 }]], column: 10 },
  { text: '["}, {", {a: 1, b: 2}]', value: ["}, {", { a: 1, b: 2 }], column: 17 },
] as const;

describe("Landofile flow collections", () => {
  test.each([...mappings])("v4 rejects populated flow mappings in $text", ({ text, column }) => {
    // Given
    const content = `value: ${text}\n`;
    // When
    const result = Effect.runSync(Effect.either(parseLandofile({ file, content, cwd: "/app" })));
    // Then
    expect(result._tag).toBe("Left");
    if (result._tag !== "Left") throw new Error("Expected a parse failure, not fragmented scalar values");
    expect(result.left).toMatchObject({ _tag: "LandofileParseError", filePath: file, line: 1, column });
    expect(result.left.remediation).toMatch(/block/i);
  });

  test.each([...mappings])("legacy mode parses nested flow collections in $text", ({ text, value }) => {
    // Given
    const content = `value: ${text}\n`;
    // When
    const result = Effect.runSync(parseLegacyLandofile({ mode: "legacy", file, content }));
    // Then
    expect(result.value).toEqual({ value });
  });

  test.each([
    {
      text: "[[1, 2], [3, 4]]",
      value: [
        [1, 2],
        [3, 4],
      ],
    },
    { text: '["a,b", "{", "}", "[x,y]"]', value: ["a,b", "{", "}", "[x,y]"] },
    { text: "['a,b', '{', '}', '[x,y]']", value: ["a,b", "{", "}", "[x,y]"] },
    { text: '["a\\",{b", "c"]', value: ['a",{b', "c"] },
    { text: "[{}, [1, 2], {}]", value: [{}, [1, 2], {}] },
  ])("v4 preserves supported flow values in $text", ({ text, value }) => {
    // Given
    const content = `value: ${text}\n`;
    // When
    const result = Effect.runSync(parseLandofile({ file, content, cwd: "/app" }));
    // Then
    expect(result).toEqual({ value });
  });
});
