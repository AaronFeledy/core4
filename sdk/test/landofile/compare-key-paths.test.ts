import { describe, expect, test } from "bun:test";

import { compareKeyPaths } from "@lando/sdk/landofile";

describe("compareKeyPaths", () => {
  test("orders equal paths as equal", () => {
    expect(compareKeyPaths(["services", 0, "image"], ["services", 0, "image"])).toBe(0);
  });

  test("orders numeric segments numerically", () => {
    expect(compareKeyPaths(["ports", 2], ["ports", 10])).toBeLessThan(0);
    expect(compareKeyPaths(["ports", 10], ["ports", 2])).toBeGreaterThan(0);
  });

  test("orders a number before a string at the same index", () => {
    expect(compareKeyPaths(["ports", 1], ["ports", "published"])).toBeLessThan(0);
    expect(compareKeyPaths(["ports", "published"], ["ports", 1])).toBeGreaterThan(0);
  });

  test("orders strings lexicographically", () => {
    expect(compareKeyPaths(["environment"], ["image"])).toBeLessThan(0);
  });

  test("orders a shorter shared prefix first", () => {
    expect(compareKeyPaths(["services"], ["services", "web"])).toBeLessThan(0);
    expect(compareKeyPaths(["services", "web"], ["services"])).toBeGreaterThan(0);
  });
});
