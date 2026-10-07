import { describe, expect, test } from "bun:test";

import { errnoCode, isErrnoCode } from "@lando/sdk/errors";

const errnoError = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });

describe("isErrnoCode", () => {
  test("matches an Error carrying the requested code", () => {
    expect(isErrnoCode(errnoError("ENOENT"), "ENOENT")).toBe(true);
  });

  test("rejects an Error carrying a different code", () => {
    expect(isErrnoCode(errnoError("EEXIST"), "ENOENT")).toBe(false);
  });

  test("matches a plain object carrying the code structurally", () => {
    expect(isErrnoCode({ code: "EACCES" }, "EACCES")).toBe(true);
  });

  test("rejects values without a code", () => {
    expect(
      [null, undefined, "ENOENT", 2, new Error("ENOENT"), {}].map((cause) => isErrnoCode(cause, "ENOENT")),
    ).toEqual([false, false, false, false, false, false]);
  });
});

describe("errnoCode", () => {
  test.each([
    [{ code: "ENOENT" }, "ENOENT"],
    [errnoError("EACCES"), "EACCES"],
    [{ code: "" }, ""],
    [{ code: 2 }, undefined],
    [null, undefined],
    ["x", undefined],
    [{}, undefined],
    [undefined, undefined],
  ])("extracts only string codes from %p", (cause, expected) => {
    // Given the structural cause above.
    // When extracting its errno code.
    const result = errnoCode(cause);
    // Then only a string code is retained.
    expect(result).toBe(expected);
  });
});
