import { describe, expect, test } from "bun:test";

import {
  MalformedCliFlagValueError,
  UnknownCliFlagError,
  validateCliFlagValues,
  validateCommandCliFlags,
  validateUnknownCliFlags,
} from "../../src/cli/flag-value-validation.ts";

const flags = {
  provider: { type: "option" },
  service: { type: "option", char: "s" },
  follow: { type: "boolean", char: "f" },
  shell: { type: "option", options: ["posix", "powershell", "pwsh"] },
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
    ["truncated short bundle", ["-fs"], "missing"],
    ["undeclared option value", ["--shell=private-shell"], "invalid_option"],
    ["boolean with attached value", ["--yes=private-confirmation"], "unexpected"],
    ["short boolean with attached value", ["-fprivate-follow"], "unexpected"],
  ])("returns one tagged error for %s", (_name, argv, issue) => {
    const error = validateCliFlagValues(argv, flags);

    expect(error).toBeInstanceOf(MalformedCliFlagValueError);
    expect(error).toMatchObject({ _tag: "MalformedCliFlagValueError", issue });
  });

  test.each([
    ["separated values", ["--provider", "podman"]],
    ["equals values", ["--provider=podman"]],
    ["repeatable values", ["--answer", "php=8.3", "--answer=database=mysql"]],
    ["short boolean bundle with attached option value", ["-fsappserver"]],
    ["declared option value", ["--shell=pwsh"]],
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

  test("does not disclose an invalid declared option value", () => {
    const error = validateCliFlagValues(["--shell=private-shell"], flags);

    expect(error).toMatchObject({
      _tag: "MalformedCliFlagValueError",
      flag: "shell",
      issue: "invalid_option",
    });
    expect(JSON.stringify(error)).not.toContain("private-shell");
  });

  test.each([
    ["long", ["--yes=private-confirmation"], "yes", "private-confirmation"],
    ["short", ["-fprivate-follow"], "follow", "private-follow"],
  ])("does not disclose a value attached to a %s boolean flag", (_name, argv, flag, suppliedValue) => {
    const error = validateCliFlagValues(argv, flags);

    expect(error).toMatchObject({
      _tag: "MalformedCliFlagValueError",
      flag,
      issue: "unexpected",
    });
    expect(JSON.stringify(error)).not.toContain(suppliedValue);
  });

  test("accepts an explicitly allowed empty option value", () => {
    expect(validateCliFlagValues(["--provider="], flags, ["provider"])).toBeUndefined();
  });

  test("rejects an unknown flag without retaining its attached value", () => {
    const error = validateUnknownCliFlags(["--future=private-value"], flags);

    expect(error).toBeInstanceOf(UnknownCliFlagError);
    expect(error).toMatchObject({
      _tag: "UnknownCliFlagError",
      flag: "--future",
      message: "Nonexistent flag: --future",
    });
    expect(JSON.stringify(error)).not.toContain("private-value");
  });

  test("rejects an unknown short flag without retaining its attached value", () => {
    const error = validateUnknownCliFlags(["-zprivate-value"], flags);

    expect(error).toMatchObject({
      _tag: "UnknownCliFlagError",
      flag: "-z",
      message: "Nonexistent flag: -z",
    });
    expect(JSON.stringify(error)).not.toContain("private-value");
  });

  test("allows forwarded flags for non-strict passthrough commands", () => {
    expect(
      validateCommandCliFlags({
        commandId: "app:exec",
        argv: ["appserver", "sh", "-c", "echo hi"],
        definitions: flags,
        allowUnknownFlags: true,
      }),
    ).toBeUndefined();
  });
});
