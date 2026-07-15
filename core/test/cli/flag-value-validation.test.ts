import { describe, expect, test } from "bun:test";

import { MalformedCliFlagValueError, validateCliFlagValues } from "../../src/cli/flag-value-validation.ts";

const flags = {
  provider: { type: "option" },
  tail: { type: "option" },
  answer: { type: "option", multiple: true },
  yes: { type: "boolean" },
} as const;

describe("CLI flag-value validation", () => {
  test.each([
    ["option at end", ["--provider"], "missing"],
    ["option before a recognized flag", ["--provider", "--yes"], "missing"],
    ["empty equals value", ["--provider="], "empty"],
    ["non-integer tail", ["--tail=12x"], "invalid_integer"],
    ["repeated non-repeatable option", ["--provider", "podman", "--provider=docker"], "repeated"],
  ])("returns one tagged error for %s", (_name, argv, issue) => {
    const error = validateCliFlagValues(argv, flags);

    expect(error).toBeInstanceOf(MalformedCliFlagValueError);
    expect(error).toMatchObject({ _tag: "MalformedCliFlagValueError", issue });
  });

  test.each([
    ["separated values", ["--provider", "podman"]],
    ["equals values", ["--provider=podman"]],
    ["repeatable values", ["--answer", "php=8.3", "--answer=database=mysql"]],
    ["unknown flags", ["--future", "value"]],
  ])("accepts %s", (_name, argv) => {
    expect(validateCliFlagValues(argv, flags)).toBeUndefined();
  });

  test("does not disclose supplied values in the error", () => {
    const error = validateCliFlagValues(
      ["--provider", "private-provider", "--provider=private-provider-2"],
      flags,
    );

    expect(JSON.stringify(error)).not.toContain("private-provider");
  });

  test("accepts an explicitly allowed empty option value", () => {
    expect(validateCliFlagValues(["--provider="], flags, ["provider"])).toBeUndefined();
  });
});
