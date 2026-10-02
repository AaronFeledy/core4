import { describe, expect, test } from "bun:test";
import {
  booleanFlag,
  formatFlag,
  specArgsOf,
  specFlagsOf,
  stringArrayFlag,
  stringFlag,
} from "../../../src/cli/spec/input-coercion";

describe("spec input coercion", () => {
  for (const extract of [specFlagsOf, specArgsOf]) {
    test.each([null, undefined, false, "x", {}, { flags: "x", args: "x" }, { flags: [1], args: [1] }])(
      "returns an empty record when input has no record (%p)",
      (input) => {
        const result = extract(input);
        expect(result).toEqual({});
      },
    );

    test("copies only own enumerable entries when a record is supplied", () => {
      const record = Object.create({ inherited: true });
      Object.defineProperty(record, "hidden", { value: true });
      record.name = "app";
      const result = extract({ flags: record, args: record });
      expect(result).toEqual({ name: "app" });
      expect(result).not.toBe(record);
    });
  }

  test.each([
    ["", ""],
    ["hello", "hello"],
    [1, undefined],
    [true, undefined],
    [undefined, undefined],
  ])("keeps only strings when the flag is %p", (value, expected) => {
    const result = stringFlag({ name: value }, "name");
    expect(result).toBe(expected);
  });

  test.each([true, false, "true", 1, undefined, null])(
    "accepts only literal true when flag is %p",
    (value) => {
      const result = booleanFlag({ enabled: value }, "enabled");
      expect(result).toBe(value === true);
    },
  );

  test.each([
    { value: ["a", 1, "b"], expected: ["a", "b"] },
    { value: "a", expected: ["a"] },
    { value: "", expected: [""] },
    { value: [1, null], expected: [] },
    { value: undefined, expected: [] },
    { value: 1, expected: [] },
  ])("collects string members when service is $value", ({ value, expected }) => {
    const result = stringArrayFlag({ service: value }, "service");
    expect(result).toEqual(expected);
  });

  test.each([
    { value: "yaml", expected: "yaml" },
    { value: "json", expected: "json" },
    { value: "xml", expected: "json" },
    { value: undefined, expected: "json" },
    { value: 1, expected: "json" },
  ])("selects an allowed format or fallback when format is $value", ({ value, expected }) => {
    const result = formatFlag({ format: value }, ["json", "yaml"], "json");
    expect(result).toBe(expected);
  });
});
