import { describe, expect, test } from "bun:test";

import {
  MINIMUM_PODMAN_VERSION,
  parsePodmanVersionNumbers,
  podmanVersionMeetsFloor,
} from "../src/podman/version-floor.ts";

describe("podman version floor", () => {
  test("uses Podman 6 as the minimum", () => {
    // Given / When / Then
    expect(MINIMUM_PODMAN_VERSION).toBe("6.0.0");
  });

  test("parses numeric versions while ignoring suffixes", () => {
    // Given / When / Then
    expect(parsePodmanVersionNumbers("6.1.0-rc1")).toEqual({ major: 6, minor: 1, patch: 0 });
    expect(parsePodmanVersionNumbers("6.0.2+build.5")).toEqual({ major: 6, minor: 0, patch: 2 });
    expect(parsePodmanVersionNumbers("podman version 5.2.0")).toEqual({ major: 5, minor: 2, patch: 0 });
    expect(parsePodmanVersionNumbers("not a version")).toBeUndefined();
  });

  test("compares major, minor, and patch numerically", () => {
    // Given / When / Then
    expect(podmanVersionMeetsFloor("5.2.0", "6.0.0")).toBe(false);
    expect(podmanVersionMeetsFloor("6.0.0", "6.0.0")).toBe(true);
    expect(podmanVersionMeetsFloor("6.1.0-rc1", "6.0.0")).toBe(true);
    expect(podmanVersionMeetsFloor("10.0.0", "6.0.0")).toBe(true);
    expect(podmanVersionMeetsFloor("6.0.0", "6.0.1")).toBe(false);
    expect(podmanVersionMeetsFloor("not a version", "6.0.0")).toBe(false);
  });
});
