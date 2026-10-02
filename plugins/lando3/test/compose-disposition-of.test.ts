import { describe, expect, test } from "bun:test";

import { dispositionOf } from "../src/compose-disposition-of.ts";
import snapshot from "./fixtures/compose-dispositions.snapshot.json";

describe("dispositionOf", () => {
  test("reproduces every frozen service disposition", () => {
    // Given
    const entries = Object.entries(snapshot);

    // When / Then
    expect(entries.length).toBeGreaterThan(0);
    for (const [path, disposition] of entries) {
      const actual: string = dispositionOf(path);
      expect(actual, path).toBe(disposition);
    }
  });

  test("returns unknown for a path outside the matrix", () => {
    expect(dispositionOf("not.a.real.key")).toBe("unknown");
  });
});
