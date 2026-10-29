import { expect, test } from "bun:test";
import { ToolingInputDeclaration, type ToolingTaskShape } from "@lando/sdk/schema";
import { Result, Schema } from "effect";
import { normalizeToolingInput } from "../src/tooling-input-normalize.ts";
import { toolingInputRedactionTokens } from "../src/tooling-input-redaction.ts";
import { bindToolingInput } from "../src/tooling-input.ts";

const invalidMetadata: readonly ToolingTaskShape[] = [
  { flags: { mode: { sensitive: true as const, default: "canary" } } },
  { flags: { apiToken: { choices: ["canary"] } } },
  { args: { target: { sensitive: true as const, choices: ["canary"] } } },
  { args: { password: { default: "canary" } } },
];
test.each(invalidMetadata)("refuses sensitive literal metadata without retaining values: %j", (authored) => {
  // Given / When
  const result = normalizeToolingInput("probe", authored);
  // Then
  expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "ToolingCompileError" } });
  expect(JSON.stringify(result)).not.toContain("canary");
});

test("classifies every raw sensitive occurrence across errors and overwrites", () => {
  // Given
  const declaration = Result.getOrThrow(
    normalizeToolingInput("probe", {
      flags: { mode: { alias: "m", sensitive: true } },
      args: { target: { sensitive: true } },
    }),
  );
  const argv = ["--unknown=bad", "--mode=first", "-m", "second", "--mode=third", "--", "fourth"];
  // When
  const tokens = toolingInputRedactionTokens([declaration], { _tag: "RawArgv", argv });
  // Then
  expect(tokens).toEqual(["first", "second", "third", "fourth"]);
});

test.each([
  { argv: ["--token", "src"], enabled: true },
  { argv: ["-t", "src"], enabled: true },
  { argv: ["--token=true", "src"], enabled: true },
  { argv: ["--token=false", "src"], enabled: false },
])(
  "does not classify boolean switches or their following positionals as secrets: %j",
  ({ argv, enabled }) => {
    // Given
    const declaration = Result.getOrThrow(
      normalizeToolingInput("probe", { flags: { token: { alias: "t", boolean: true } }, args: { path: {} } }),
    );
    // When
    const tokens = toolingInputRedactionTokens([declaration], { _tag: "RawArgv", argv });
    const values = Result.getOrThrow(
      bindToolingInput({ name: "probe" }, declaration, { _tag: "RawArgv", argv }),
    );
    // Then
    expect(values).toEqual({ flags: { token: enabled }, args: { path: "src" } });
    expect(tokens).toEqual([]);
    expect(toolingInputRedactionTokens([declaration], { _tag: "NamedMaps", ...values })).toEqual([]);
  },
);

test("retains malformed sensitive boolean values before admission rejects them", () => {
  // Given
  const declaration = Result.getOrThrow(
    normalizeToolingInput("probe", { flags: { token: { boolean: true } } }),
  );
  // When
  const tokens = toolingInputRedactionTokens([declaration], { _tag: "RawArgv", argv: ["--token=canary"] });
  // Then
  expect(tokens).toEqual(["canary"]);
});

test("combines advertised and current sensitivity for stale named maps", () => {
  // Given
  const old = Result.getOrThrow(normalizeToolingInput("probe", { flags: { old: { sensitive: true } } }));
  const current = Result.getOrThrow(
    normalizeToolingInput("probe", { args: { current: { sensitive: true } } }),
  );
  // When
  const tokens = toolingInputRedactionTokens([old, current], {
    _tag: "NamedMaps",
    flags: { old: ["before", { nested: "nested" }] },
    args: { current: "after" },
  });
  // Then
  expect(tokens).toEqual(["before", "nested", "after"]);
});

test("classifies deeply nested malformed sensitive values in traversal order", () => {
  // Given
  const declaration = Result.getOrThrow(
    normalizeToolingInput("probe", { flags: { note: { sensitive: true } } }),
  );
  let nested: unknown = "deep-canary";
  for (let depth = 0; depth < 20_000; depth++) nested = { child: nested };
  // When
  const tokens = toolingInputRedactionTokens([declaration], {
    _tag: "NamedMaps",
    flags: { note: { before: "first", nested, after: "last" } },
    args: {},
  });
  // Then
  expect(tokens).toEqual(["first", "deep-canary", "last"]);
});

test("round-trips effective sensitivity and ordered parsing semantics", () => {
  // Given
  const input = Result.getOrThrow(
    normalizeToolingInput("probe", {
      flags: { mode: { sensitive: true }, apiToken: {} },
      args: { first: {} },
    }),
  );
  // When
  const roundTrip = Schema.decodeUnknownSync(ToolingInputDeclaration)(
    Schema.encodeSync(ToolingInputDeclaration)(input),
    { onExcessProperty: "error" },
  );
  // Then
  expect(roundTrip).toEqual(input);
  expect(roundTrip.flags.map((flag) => flag.sensitive)).toEqual([true, true]);
});
