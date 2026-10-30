import { expect, test } from "bun:test";
import { LandofileParseError } from "@lando/sdk/errors";
import { parseLandofile } from "@lando/sdk/landofile";
import { override, reset } from "@lando/sdk/landofile";
import { Effect, Result } from "effect";

test.each([
  ["value: [\"echo # hi\", 'it''s # literal'] # tail", { value: ["echo # hi", "it's # literal"] }],
  [
    'value:\n  - "echo # hi" # tail\n  - item: "more # text" # tail',
    { value: ["echo # hi", { item: "more # text" }] },
  ],
  ['"quoted # key": ["escaped \\" # quote"] # tail', { "quoted # key": ['escaped " # quote'] }],
  ["value: it's fine # tail", { value: "it's fine" }],
  ["value: sh -c 'echo # hi'", { value: "sh -c 'echo" }],
  ['value: &text "echo # hi" # tail\ncopy: *text', { value: "echo # hi", copy: "echo # hi" }],
  ["value: ${HOME}\nescaped: $${HOME}", { value: "${HOME}", escaped: "$${HOME}" }],
  ['value: !override ["echo # hi"] # tail', { value: override(["echo # hi"]) }],
  ['value: !reset "discard # hi" # tail', { value: reset() }],
  ['value: |\n  # literal comment\n  "quoted # text"\n', { value: '# literal comment\n"quoted # text"\n' }],
] as const)("preserves native YAML lexical integrity: %s", async (content, expected) => {
  // Given / When
  const parsed = await Effect.runPromise(parseLandofile({ file: ".lando.yml", cwd: "/tmp", content }));
  // Then
  expect(parsed).toEqual(expected);
});

test.each([
  'value: {key: "echo # hi"} # tail',
  "value: {key: 'it''s # literal'} # tail",
  'value: {key: "escaped \\" # quote"} # tail',
  'value:\n  - {key: "echo # hi"} # tail',
  'value: !override {key: "echo # hi"} # tail',
])("rejects populated native flow maps without truncation: %s", async (content) => {
  // Given / When
  const result = await Effect.runPromise(
    Effect.result(parseLandofile({ file: ".lando.yml", cwd: "/tmp", content })),
  );
  // Then
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result)) {
    expect(result.failure).toBeInstanceOf(LandofileParseError);
    expect(result.failure.message).toContain("Inline objects");
  }
});
