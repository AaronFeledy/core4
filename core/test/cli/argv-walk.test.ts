import { describe, expect, test } from "bun:test";

import { findArgvFlag } from "../../src/cli/argv-walk.ts";

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
