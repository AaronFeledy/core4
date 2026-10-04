import { describe, expect, test } from "bun:test";

import { findArgvFlag, scanArgvFlags } from "../../src/cli/argv-walk.ts";

describe("scanArgvFlags", () => {
  test("preserves the terminator and tail without matching them", () => {
    // Given
    const argv = ["command", "--strip", "--", "--strip", "--", "child"];
    const visited: string[] = [];
    // When
    const remaining = scanArgvFlags(argv, (arg) => {
      visited.push(arg);
      return arg === "--strip" ? { consumed: 0 } : undefined;
    });
    // Then
    expect(remaining).toEqual(["command", "--", "--strip", "--", "child"]);
    expect(visited).toEqual(["command", "--strip"]);
  });

  test("skips exactly one following token when a match consumes it", () => {
    // Given
    const argv = ["--value", "payload", "keep", "--strip", "last"];
    const visited: Array<readonly [string, string | undefined]> = [];
    // When
    const remaining = scanArgvFlags(argv, (arg, next) => {
      visited.push([arg, next]);
      if (arg === "--value") return { consumed: 1 };
      if (arg === "--strip") return { consumed: 0 };
      return undefined;
    });
    // Then
    expect(remaining).toEqual(["keep", "last"]);
    expect(visited).toEqual([
      ["--value", "payload"],
      ["keep", "--strip"],
      ["--strip", "last"],
      ["last", undefined],
    ]);
  });

  test("stops at the end when the last match requests a following token", () => {
    // Given
    const visited: Array<readonly [string, string | undefined]> = [];
    // When
    const remaining = scanArgvFlags(["--value"], (arg, next) => {
      visited.push([arg, next]);
      return { consumed: 1 };
    });
    // Then
    expect(remaining).toEqual([]);
    expect(visited).toEqual([["--value", undefined]]);
  });

  test("skips sparse holes before and after the terminator", () => {
    // Given
    const argv = new Array<string>(5);
    argv[1] = "keep";
    argv[2] = "--";
    argv[4] = "child";
    const visited: string[] = [];
    // When
    const remaining = scanArgvFlags(argv, (arg) => {
      visited.push(arg);
      return undefined;
    });
    // Then
    expect(remaining).toEqual(["keep", "--", "child"]);
    expect(visited).toEqual(["keep"]);
  });

  test("propagates matcher exceptions", () => {
    // Given
    const failure = new TypeError("matcher failed");
    // When / Then
    expect(() =>
      scanArgvFlags(["--invalid"], () => {
        throw failure;
      }),
    ).toThrow(failure);
  });
});

describe("findArgvFlag", () => {
  test("returns the first hit even when it is falsy", () => {
    // Given
    const visited: Array<readonly [string, string | undefined]> = [];
    // When
    const found = findArgvFlag(["keep", "--first", "--second"], (arg, next) => {
      visited.push([arg, next]);
      return arg.startsWith("--") ? false : undefined;
    });
    // Then
    expect(found).toBe(false);
    expect(visited).toEqual([
      ["keep", "--first"],
      ["--first", "--second"],
    ]);
  });

  test("does not probe the terminator or its tail", () => {
    // Given
    const visited: string[] = [];
    // When
    const found = findArgvFlag(["keep", "--", "--hit"], (arg) => {
      visited.push(arg);
      return arg.startsWith("--") ? arg : undefined;
    });
    // Then
    expect(found).toBeUndefined();
    expect(visited).toEqual(["keep"]);
  });

  test.each([{ argv: [] }, { argv: ["keep", "positional"] }])(
    "returns undefined when no token matches $argv",
    ({ argv }) => {
      // Given / When
      const found = findArgvFlag(argv, (arg) => (arg === "--hit" ? arg : undefined));
      // Then
      expect(found).toBeUndefined();
    },
  );

  test("skips sparse holes while searching", () => {
    // Given
    const argv = new Array<string>(2);
    argv[1] = "--hit";
    // When
    const found = findArgvFlag(argv, (arg) => (arg.startsWith("--") ? arg : undefined));
    // Then
    expect(found).toBe("--hit");
  });

  test("propagates probe exceptions", () => {
    // Given
    const failure = new TypeError("probe failed");
    // When / Then
    expect(() =>
      findArgvFlag(["--invalid"], () => {
        throw failure;
      }),
    ).toThrow(failure);
  });
});
