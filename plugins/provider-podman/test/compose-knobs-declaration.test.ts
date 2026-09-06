import { describe, expect, test } from "bun:test";

import { podmanComposeKnobs } from "@lando/container-runtime/podman/compose-knobs";
import { podmanCapabilitiesForPlatform } from "@lando/provider-podman";

const PLATFORMS = ["linux", "darwin", "win32"] as const;

describe("provider-podman Compose knob declarations", () => {
  for (const platform of PLATFORMS) {
    test(`podman on ${platform} matches the shared Podman Compose knobs`, () => {
      const capabilities = podmanCapabilitiesForPlatform(platform);

      expect(capabilities.composeSpec).toBe("native");
      expect(capabilities.composeKnobs?.supported).toEqual(podmanComposeKnobs());
      expect(capabilities.composeServiceFields?.supported).toEqual(["labels", "configs"]);
    });
  }
});
