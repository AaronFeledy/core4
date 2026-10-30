import { expect, test } from "bun:test";
import { BunShellScriptFrontMatter, ToolingInputValues, getJsonSchema } from "@lando/sdk/schema";
import { Schema } from "effect";

test("round-trips a data-only script input record through JSON", () => {
  // Given
  const input = {
    flags: { loud: true, quiet: false, target: "two words" },
    args: { release: "r1" },
  };
  // When
  const decoded = Schema.decodeUnknownSync(ToolingInputValues)(JSON.parse(JSON.stringify(input)), {
    onExcessProperty: "error",
  });
  const encoded = Schema.encodeSync(ToolingInputValues)(decoded);
  // Then
  expect(encoded).toEqual(input);
  expect(Schema.decodeUnknownSync(ToolingInputValues)(encoded, { onExcessProperty: "error" })).toEqual(
    decoded,
  );
});

test.each([
  { flags: { count: 1 }, args: {} },
  { flags: {}, args: { count: false } },
  { flags: {}, args: {}, argv: [false] },
  { flags: {} },
  { flags: {}, args: {}, argv: [], cmd: "echo bad" },
])("rejects non-data or incorrectly typed script inputs: %j", (input) => {
  // Given / When / Then
  expect(() => Schema.decodeUnknownSync(ToolingInputValues)(input, { onExcessProperty: "error" })).toThrow();
});

test("publishes the script input record as a JSON schema", () => {
  // Given / When
  const schema = getJsonSchema("ToolingInputValues");
  // Then
  expect(schema).toMatchObject({ type: "object", required: ["flags", "args"] });
});

test("decodes front matter with the same nested declaration shapes as tooling", () => {
  // Given
  const input = {
    service: ":host",
    desc: "Help",
    disabled: true,
    flags: { dry: { boolean: true, default: false } },
    args: { release: { order: 0, required: true } },
  };
  // When
  const decoded = Schema.decodeUnknownSync(BunShellScriptFrontMatter)(input, { onExcessProperty: "error" });
  // Then
  expect(Schema.encodeSync(BunShellScriptFrontMatter)(decoded)).toEqual(input);
});
