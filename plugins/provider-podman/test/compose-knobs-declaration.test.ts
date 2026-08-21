import { describe, expect, test } from "bun:test";

import { providerLandoCapabilitiesForPlatform } from "@lando/provider-lando";
import { podmanCapabilitiesForPlatform } from "@lando/provider-podman";
import { ComposeServiceKnobKey } from "@lando/sdk/schema";
import { KNOB_FIXTURES } from "./compose-knobs-fixtures.ts";

const PLATFORMS = ["linux", "darwin", "win32"] as const;
const PROVIDERS = [
  ["lando", providerLandoCapabilitiesForPlatform],
  ["podman", podmanCapabilitiesForPlatform],
] as const;
const fixtureKeys = new Set(Object.keys(KNOB_FIXTURES));
const expectedKnobs = ComposeServiceKnobKey.literals.filter((key) => fixtureKeys.has(key));

describe("Podman-backed Compose knob declarations", () => {
  for (const [provider, capabilitiesForPlatform] of PROVIDERS) {
    for (const platform of PLATFORMS) {
      test(`${provider} on ${platform} exactly matches the independently proven realization fixtures`, () => {
        const capabilities = capabilitiesForPlatform(platform);

        expect(capabilities.composeSpec).toBe("native");
        expect(capabilities.composeKnobs?.supported).toEqual(expectedKnobs);
        expect(capabilities.composeServiceFields?.supported).toEqual(["labels", "configs"]);
      });
    }
  }
});
