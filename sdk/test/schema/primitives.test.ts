import { describe, expect, test } from "bun:test";

import { hostPlatformFamily } from "@lando/sdk/schema";

describe("hostPlatformFamily", () => {
  test.each([
    ["darwin", "darwin"],
    ["linux", "linux"],
    ["win32", "win32"],
    ["wsl", "linux"],
  ] as const)("projects %s identity to the %s family", (platform, expectedFamily) => {
    // Given: a canonical host identity.
    // When: behavior selects its platform family.
    const family = hostPlatformFamily(platform);

    // Then: only WSL collapses into the Linux behavior family.
    expect(family).toBe(expectedFamily);
  });
});
