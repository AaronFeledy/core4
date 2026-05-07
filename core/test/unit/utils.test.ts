/**
 * Pure-function helpers from `src/utils/`.
 */
import { describe, expect, test } from "bun:test";

import { slugify } from "../../src/utils/path.ts";

describe("slugify", () => {
  test("lowercases and replaces non-alphanumerics with hyphens", () => {
    expect(slugify("My App")).toBe("my-app");
    expect(slugify("Foo_Bar.Baz")).toBe("foo-bar-baz");
  });

  test("collapses runs of hyphens", () => {
    expect(slugify("a---b___c")).toBe("a-b-c");
  });

  test("trims leading/trailing hyphens", () => {
    expect(slugify("--hello--")).toBe("hello");
  });
});
