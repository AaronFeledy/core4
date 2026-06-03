import { describe, expect, test } from "bun:test";

import { stripAnsi } from "./normalize.ts";

describe("stripAnsi", () => {
  test("strips SGR color sequences", () => {
    expect(stripAnsi("plain \x1b[31mred\x1b[0m done")).toBe("plain red done");
    expect(stripAnsi("\x1b[1;38;5;204mhot\x1b[0m")).toBe("hot");
  });

  test("stops CSI stripping at non-SGR final bytes", () => {
    expect(stripAnsi("before\x1b[2Kafter\x1b[1;31Hhome\x1b[?25lhidden")).toBe("beforeafterhomehidden");
  });

  test("drops a truncated CSI sequence without emitting partial escape bytes", () => {
    expect(stripAnsi("before\x1b[?25")).toBe("before");
  });
});
