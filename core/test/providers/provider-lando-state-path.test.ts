import { describe, expect, test } from "bun:test";

import { providerStatePath } from "@lando/provider-lando";
import { providerLandoSetupStatePath } from "@lando/provider-podman";

/**
 * `@lando/provider-podman` mirrors provider-lando's setup-state path for its
 * cross-plugin conflict probe instead of depending on `@lando/provider-lando`
 * (the workspace forbids plugin→plugin edges). Core depends on both, so it
 * owns the pin that keeps the two spellings identical.
 */
describe("provider-lando setup-state path mirror", () => {
  test.each(["/tmp/lando/providers", "/tmp/lando/providers///", "C:/Users/me/AppData/Lando/providers"])(
    "matches the provider-lando owner for %s",
    (stateDir) => {
      expect(providerLandoSetupStatePath(stateDir)).toBe(providerStatePath(stateDir));
    },
  );
});
