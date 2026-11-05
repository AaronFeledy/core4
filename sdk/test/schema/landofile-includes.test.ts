import { expect, test } from "bun:test";
import { IncludeEntry, ToolingIncludeShape } from "@lando/sdk/schema";
import { Result, Schema } from "effect";

test.each(
  (["landofile", "compose", "tooling"] as const).flatMap((kind) =>
    [false, true, "{{ boolean(default(env.ENABLED, '0')) }}"].map((when) => ({
      source: "./fragment.yml",
      kind,
      when,
    })),
  ),
)("$kind includes preserve when=$when through the public codec", (input) => {
  const decoded = Schema.decodeUnknownSync(IncludeEntry)(input, { onExcessProperty: "error" });
  expect(Schema.encodeSync(IncludeEntry)(decoded)).toEqual(input);
});

test("tooling shorthand keeps condition and missing-file policy distinct", () => {
  const input = { file: "./tasks.yml", when: false, optional: true };
  const decoded = Schema.decodeUnknownSync(ToolingIncludeShape)(input, { onExcessProperty: "error" });
  expect(Schema.encodeSync(ToolingIncludeShape)(decoded)).toEqual(input);
});

test("include conditions reject numeric literals at the schema boundary", () => {
  const decoded = Schema.decodeUnknownResult(IncludeEntry)(
    { source: "./fragment.yml", when: 1 },
    { onExcessProperty: "error" },
  );
  expect(Result.isFailure(decoded)).toBe(true);
});
