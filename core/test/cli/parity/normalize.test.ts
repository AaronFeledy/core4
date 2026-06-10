import { describe, expect, test } from "bun:test";

import { normalizeOutput, stripAnsi } from "./normalize.ts";

describe("normalizeOutput", () => {
  test("strips the /proc/self/exe ' (deleted)' runtime marker so a rebuilt binary path stays at parity", () => {
    const withMarker =
      "- installed binary: user-owned — /home/me/dist/lando (deleted). Remove /home/me/dist/lando (deleted) manually.";
    const withoutMarker =
      "- installed binary: user-owned — /home/me/dist/lando. Remove /home/me/dist/lando manually.";
    expect(normalizeOutput(withMarker)).toBe(normalizeOutput(withoutMarker));
    expect(normalizeOutput(withMarker)).not.toContain("(deleted)");
  });
});

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
