import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { detectLandofileTags, parseLandofile, parseLegacyLandofile } from "@lando/sdk/landofile";

const file = "/app/.lando.yml";
const genericRemediation =
  "Rewrite the flow mapping as an indented block mapping; use a block sequence for mapping items.";
const simpleAbRemediation = ["Rewrite the flow mapping as a block mapping:", "a: 1", "b: 2"].join("\n");
const mappings = [
  {
    text: "[{a: 1, b: 2}, {c: 3}]",
    value: [{ a: 1, b: 2 }, { c: 3 }],
    column: 9,
    // First rejected member is the simple `{a: 1, b: 2}` pair (no parent key).
    remediation: simpleAbRemediation,
  },
  {
    text: "{a: [1, 2]}",
    value: { a: [1, 2] },
    column: 8,
    remediation: genericRemediation,
  },
  {
    text: "[{a: [1, 2], b: [3, 4]}]",
    value: [{ a: [1, 2], b: [3, 4] }],
    column: 9,
    remediation: genericRemediation,
  },
  {
    text: "[[{a: 1, b: 2}]]",
    value: [[{ a: 1, b: 2 }]],
    column: 10,
    remediation: simpleAbRemediation,
  },
  {
    text: '["}, {", {a: 1, b: 2}]',
    value: ["}, {", { a: 1, b: 2 }],
    column: 17,
    remediation: simpleAbRemediation,
  },
] as const;

describe("Landofile flow collections", () => {
  test.each([...mappings])("v4 rejects populated flow mappings in $text", ({ text, column, remediation }) => {
    // Given
    const content = `value: ${text}\n`;
    // When
    const result = Effect.runSync(Effect.result(parseLandofile({ file, content, cwd: "/app" })));
    // Then
    expect(result._tag).toBe("Failure");
    if (result._tag !== "Failure") throw new Error("Expected a parse failure, not fragmented scalar values");
    expect(result.failure).toMatchObject({ _tag: "LandofileParseError", filePath: file, line: 1, column });
    expect(result.failure.remediation).toBe(remediation);
  });

  test("v4 simple single-level flow mapping remediation rewrites under the parent key", () => {
    // Given
    const content = "healthcheck: {disable: true, timeout: 5s}\n";
    // When
    const result = Effect.runSync(Effect.result(parseLandofile({ file, content, cwd: "/app" })));
    // Then
    expect(result._tag).toBe("Failure");
    if (result._tag !== "Failure") throw new Error("Expected a parse failure");
    expect(result.failure).toMatchObject({ _tag: "LandofileParseError", filePath: file, line: 1 });
    expect(result.failure.remediation).toBe(
      [
        "Rewrite the flow mapping as a block mapping:",
        "healthcheck:",
        "  disable: true",
        "  timeout: 5s",
      ].join("\n"),
    );
  });

  test("v4 simple flow mapping without a parent key still shows a block rewrite", () => {
    // Given: sequence item has no mapping parent key to thread
    const content = "mounts:\n  - {source: ./app, target: /app}\n";
    // When
    const result = Effect.runSync(Effect.result(parseLandofile({ file, content, cwd: "/app" })));
    // Then
    expect(result._tag).toBe("Failure");
    if (result._tag !== "Failure") throw new Error("Expected a parse failure");
    expect(result.failure.remediation).toBe(
      ["Rewrite the flow mapping as a block mapping:", "source: ./app", "target: /app"].join("\n"),
    );
  });

  test("v4 flow mapping with quoted separators keeps the generic remediation", () => {
    // Given
    const content = 'labels: {"a,b": 1, c: 2}\n';
    // When
    const result = Effect.runSync(Effect.result(parseLandofile({ file, content, cwd: "/app" })));
    // Then
    expect(result._tag).toBe("Failure");
    if (result._tag !== "Failure") throw new Error("Expected a parse failure");
    expect(result.failure.remediation).toBe(
      "Rewrite the flow mapping as an indented block mapping; use a block sequence for mapping items.",
    );
  });

  test("v4 safely preserves quoted scalars without separators in the suggested block", () => {
    // Given
    const content = 'healthcheck: {command: "true"}\n';
    // When
    const result = Effect.runSync(Effect.result(parseLandofile({ file, content, cwd: "/app" })));
    // Then
    expect(result._tag).toBe("Failure");
    if (result._tag !== "Failure") throw new Error("Expected a parse failure");
    expect(result.failure.remediation).toBe(
      'Rewrite the flow mapping as a block mapping:\nhealthcheck:\n  command: "true"',
    );
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
    { text: "[a}, b]", value: ["a}", "b"] },
  ])("v4 preserves supported flow values in $text", ({ text, value }) => {
    // Given
    const content = `value: ${text}\n`;
    // When
    const result = Effect.runSync(parseLandofile({ file, content, cwd: "/app" }));
    // Then
    expect(result).toEqual({ value });
  });

  test("a stray flow closer does not hide a later Compose tag", () => {
    // Given
    const content = "value: [a}, !reset]\n";
    // When
    const occurrences = detectLandofileTags({ content, file });
    // Then
    expect(occurrences).toEqual([{ tag: "!reset", line: 1, column: 13 }]);
  });
});
