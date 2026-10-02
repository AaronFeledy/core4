import { describe, expect, test } from "bun:test";

import { isErrnoCode } from "@lando/sdk/errors";

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
