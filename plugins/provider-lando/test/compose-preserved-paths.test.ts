import { describe, expect, test } from "bun:test";

import { providerLandoCapabilitiesForPlatform } from "@lando/provider-lando";

describe("provider-lando Compose preserved path capabilities", () => {
  test("leaves unrealized preserved descendants undeclared on every platform", () => {
    for (const platform of ["darwin", "linux", "win32"] as const) {
      const capabilities = providerLandoCapabilitiesForPlatform(platform);

      expect(capabilities.composePreservedPaths).toBeUndefined();
      expect(Object.hasOwn(capabilities, "composePreservedPaths")).toBe(false);
    }
  });
});
