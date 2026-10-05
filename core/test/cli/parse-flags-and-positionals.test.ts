import { describe, expect, test } from "bun:test";

import {
  type OclifFlagDefinition,
  parseFlagsAndPositionals,
  parseStringFlag,
} from "../../src/cli/compiled-argv.ts";

const definitions: Readonly<Record<string, OclifFlagDefinition>> = {
  service: { type: "option", char: "s", multiple: true },
  tail: { type: "option", valueType: "integer" },
  verbose: { type: "boolean", char: "v" },
  ratio: { type: "number" },
};

describe("parseFlagsAndPositionals", () => {
  test("binds separated, inline, aliased, and repeated values and keeps the rest as positionals", () => {
    const parsed = parseFlagsAndPositionals(
      ["web", "--service", "db", "-s=cache", "--tail=5", "-v", "extra"],
      definitions,
      { strict: true },
    );
    expect(parsed.flags).toEqual({ service: ["db", "cache"], tail: 5, verbose: true });
    expect(parsed.positionals).toEqual(["web", "extra"]);
  });

  test("a boolean flag never consumes the following token", () => {
    const parsed = parseFlagsAndPositionals(["--verbose", "web"], definitions, { strict: true });
    expect(parsed.flags).toEqual({ verbose: true });
    expect(parsed.positionals).toEqual(["web"]);
  });

  test("everything after -- is positional even when it looks like a known flag", () => {
    const parsed = parseFlagsAndPositionals(["web", "--", "--tail", "9", "-v"], definitions, {
      strict: true,
    });
    expect(parsed.flags).toEqual({});
    expect(parsed.positionals).toEqual(["web", "--tail", "9", "-v"]);
  });

  test("strict mode drops unknown dash tokens; strict:false keeps them for passthrough", () => {
    const argv = ["--unknown", "web", "-x"];
    expect(parseFlagsAndPositionals(argv, definitions, { strict: true }).positionals).toEqual(["web"]);
    expect(parseFlagsAndPositionals(argv, definitions, { strict: false }).positionals).toEqual(argv);
  });

  test("a trailing value-flag with no value is dropped without consuming anything", () => {
    const parsed = parseFlagsAndPositionals(["web", "--tail"], definitions, { strict: true });
    expect(parsed.flags).toEqual({});
    expect(parsed.positionals).toEqual(["web"]);
  });

  test("storeValue overrides value coercion but booleans still go through setParsedFlag", () => {
    const parsed = parseFlagsAndPositionals(["--ratio", "0.5", "-v", "--tail=3"], definitions, {
      strict: true,
      storeValue: (flags, name, value) => {
        flags[name] = name === "ratio" ? Number(value) : `raw:${value}`;
      },
    });
    expect(parsed.flags).toEqual({ ratio: 0.5, verbose: true, tail: "raw:3" });
  });
});

describe("parseStringFlag", () => {
  test.each([
    [["--user", "root"], 0, { value: "root", consumed: 2 }],
    [["--user=root"], 0, { value: "root", consumed: 1 }],
    [["-u", "root"], 0, { value: "root", consumed: 2 }],
    [["-u=root"], 0, { value: "root", consumed: 1 }],
    [["web", "--user", "root"], 1, { value: "root", consumed: 2 }],
  ])("reads %j at %d", (argv, index, expected) => {
    expect(parseStringFlag(argv, index, "user", "u")).toEqual(expected);
  });

  test("returns undefined for other tokens, a missing value, and a short alias it was not given", () => {
    expect(parseStringFlag(["--cwd", "/app"], 0, "user", "u")).toBeUndefined();
    expect(parseStringFlag(["--user"], 0, "user", "u")).toBeUndefined();
    expect(parseStringFlag(["-u", "root"], 0, "user")).toBeUndefined();
  });
});
