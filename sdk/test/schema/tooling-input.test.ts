import { expect, test } from "bun:test";
import {
  NormalizedToolingArg,
  NormalizedToolingFlag,
  ToolingInputDeclaration,
  ToolingInputRevision,
  ToolingInvocationInput,
} from "@lando/sdk/schema";
import { Result, Schema } from "effect";

test("round-trips the shared declaration without executable or runtime input data", () => {
  // Given
  const declaration = {
    flags: [
      {
        name: "mode",
        alias: "m",
        boolean: false,
        required: false,
        sensitive: false,
        default: "dev",
        choices: ["dev", "prod"],
      },
    ],
    args: [{ name: "file", order: 0, required: true, sensitive: true }],
    acceptsArguments: true,
    revision: ToolingInputRevision.make("revision"),
  } satisfies ToolingInputDeclaration;
  // When
  const decoded = Schema.decodeUnknownSync(ToolingInputDeclaration)(JSON.parse(JSON.stringify(declaration)), {
    onExcessProperty: "error",
  });
  // Then
  expect(Schema.encodeSync(ToolingInputDeclaration)(decoded)).toEqual(declaration);
  expect(Schema.is(NormalizedToolingFlag)(decoded.flags[0])).toBe(true);
  expect(Schema.is(NormalizedToolingArg)(decoded.args[0])).toBe(true);
  expect(() =>
    Schema.decodeUnknownSync(ToolingInputDeclaration)(
      { ...declaration, steps: [] },
      { onExcessProperty: "error" },
    ),
  ).toThrow();
});

test.each([
  { _tag: "RawArgv", argv: ["", "--flag=false", "é\n"] },
  { _tag: "NamedMaps", flags: { loud: false, empty: "" }, args: { second: "later" } },
  { _tag: "NamedMaps", flags: JSON.parse('{"__proto__":"own"}'), args: {}, passthroughArgv: ["--raw"] },
])("round-trips lossless invocation $ _tag", (input) => {
  // Given / When
  const decoded = Schema.decodeUnknownSync(ToolingInvocationInput)(input, { onExcessProperty: "error" });
  // Then
  expect(Schema.encodeSync(ToolingInvocationInput)(decoded)).toEqual(input);
});

test.each([
  { boolean: true, default: "dev" },
  { boolean: false, default: false },
  { boolean: true, choices: [] },
  { boolean: true, choices: ["dev"] },
  { boolean: false, sensitive: true, default: "dev" },
  { boolean: true, sensitive: true, default: false },
  { boolean: false, sensitive: true, choices: [] },
  { boolean: true, sensitive: true, choices: ["dev"] },
])("rejects incompatible normalized flag metadata %#", (patch) => {
  // Given
  const input = { name: "mode", required: false, sensitive: false, ...patch };
  // When
  const result = Schema.decodeUnknownResult(NormalizedToolingFlag)(input);
  // Then
  expect(Result.isFailure(result)).toBe(true);
});

test.each([
  { order: -1 },
  { order: 0.5 },
  { order: Number.POSITIVE_INFINITY },
  { order: Number.NaN },
  { default: false },
  { sensitive: true, default: "dev" },
  { sensitive: true, choices: [] },
  { sensitive: true, choices: ["dev"] },
])("rejects incompatible normalized positional metadata %#", (patch) => {
  // Given
  const input = { name: "target", order: 0, required: false, sensitive: false, ...patch };
  // When
  const result = Schema.decodeUnknownResult(NormalizedToolingArg)(input);
  // Then
  expect(Result.isFailure(result)).toBe(true);
});

test.each([
  { name: "mode", boolean: false, required: false, sensitive: false, default: "dev", choices: ["dev"] },
  { name: "force", boolean: true, required: false, sensitive: false, default: false },
  { name: "force", boolean: true, required: false, sensitive: false, default: true },
  { name: "mode", boolean: false, required: true, sensitive: true },
  { name: "force", boolean: true, required: false, sensitive: true },
] satisfies readonly NormalizedToolingFlag[])("round-trips valid normalized flag metadata %#", (input) => {
  // Given / When
  const decoded = Schema.decodeUnknownSync(NormalizedToolingFlag)(input);
  // Then
  expect(Schema.encodeSync(NormalizedToolingFlag)(decoded)).toEqual(input);
});

test.each([
  { name: "target", order: 0, required: false, sensitive: false, default: "dev", choices: ["dev"] },
  { name: "target", order: 2, required: true, sensitive: true },
] satisfies readonly NormalizedToolingArg[])(
  "round-trips valid normalized positional metadata %#",
  (input) => {
    // Given / When
    const decoded = Schema.decodeUnknownSync(NormalizedToolingArg)(input);
    // Then
    expect(Schema.encodeSync(NormalizedToolingArg)(decoded)).toEqual(input);
  },
);
