import { describe, expect, test } from "bun:test";
import { parseLandofile } from "@lando/sdk/landofile";
import { Effect } from "effect";

describe("single-quoted YAML scalars", () => {
  test.each([
    { label: "escaped apostrophe", scalar: "'it''s west'", expected: "it's west" },
    { label: "empty string", scalar: "''", expected: "" },
    { label: "literal quote", scalar: "''''", expected: "'" },
    { label: "repeated escapes", scalar: "'a''''b''c'", expected: "a''b'c" },
    {
      label: "literal backslashes",
      scalar: String.raw`'C:\tmp\it''s\n'`,
      expected: String.raw`C:\tmp\it's\n`,
    },
    { label: "quoted hash", scalar: "'it''s # west'", expected: "it's # west" },
    { label: "trailing comment", scalar: "'it''s # west' # ignored", expected: "it's # west" },
  ])("decodes $label in a mapping scalar", async ({ scalar, expected }) => {
    // Given
    const content = `value: ${scalar}\n`;
    // When
    const parsed = await Effect.runPromise(parseLandofile({ file: ".lando.yml", cwd: "/app", content }));
    // Then
    expect(parsed).toEqual({ value: expected });
  });

  test("decodes single-quoted inline sequence items without splitting quoted punctuation", async () => {
    // Given
    const content = String.raw`values: ['it''s west', '', '''', 'a''''b''c', 'C:\tmp\it''s\n', 'it''s, # west'] # ignored`;
    // When
    const parsed = await Effect.runPromise(parseLandofile({ file: ".lando.yml", cwd: "/app", content }));
    // Then
    expect(parsed).toEqual({
      values: ["it's west", "", "'", "a''b'c", String.raw`C:\tmp\it's\n`, "it's, # west"],
    });
  });
});
