import { describe, expect, test } from "bun:test";

import { podmanCapabilitiesForPlatform } from "@lando/provider-podman";
import type { HostPlatform } from "@lando/sdk/schema";
import { KNOB_FIXTURES } from "../../provider-lando/test/compose-knobs-fixtures.ts";

const declaredKnobs = (platform: HostPlatform) => {
  const composeKnobs = podmanCapabilitiesForPlatform(platform).composeKnobs;
  if (composeKnobs === undefined)
    throw new Error(`provider-podman has no Compose knob declaration on ${platform}`);
  return composeKnobs.supported;
};

describe("provider-podman Compose knob declaration", () => {
  test("matches the independently proven realization fixtures in both directions", () => {
    const declared = new Set<string>([
      ...declaredKnobs("linux"),
      ...declaredKnobs("darwin"),
      ...declaredKnobs("win32"),
    ]);
    const fixtures = new Set<string>(Object.keys(KNOB_FIXTURES));

    expect([...declared].filter((key) => !fixtures.has(key))).toEqual([]);
    expect([...fixtures].filter((key) => !declared.has(key))).toEqual([]);
  });
});
