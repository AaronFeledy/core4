import { describe, expect, test } from "bun:test";

import { PODMAN_COMPOSE_KNOB_REGISTRY } from "@lando/provider-lando";
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
  test("matches the realized registry and its independent behavioral fixtures in both directions", () => {
    const declared = new Set<string>([
      ...declaredKnobs("linux"),
      ...declaredKnobs("darwin"),
      ...declaredKnobs("win32"),
    ]);
    const registry = new Set<string>(Object.keys(PODMAN_COMPOSE_KNOB_REGISTRY));
    const fixtures = new Set<string>(Object.keys(KNOB_FIXTURES));

    expect([...declared].filter((key) => !registry.has(key))).toEqual([]);
    expect([...registry].filter((key) => !declared.has(key))).toEqual([]);
    expect(registry).toEqual(fixtures);
  });
});
