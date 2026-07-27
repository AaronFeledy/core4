import { describe, expect, test } from "bun:test";

import { PODMAN_COMPOSE_KNOB_REGISTRY } from "@lando/provider-lando";
import { podmanCapabilitiesForPlatform } from "@lando/provider-podman";
import { KNOB_FIXTURES } from "../../provider-lando/test/compose-knobs.test.ts";

describe("provider-podman Compose knob declaration", () => {
  test("matches the realized registry and its independent behavioral fixtures in both directions", () => {
    const declared = new Set([
      ...podmanCapabilitiesForPlatform("linux").composeKnobs.supported,
      ...podmanCapabilitiesForPlatform("darwin").composeKnobs.supported,
      ...podmanCapabilitiesForPlatform("win32").composeKnobs.supported,
    ]);
    const registry = new Set(Object.keys(PODMAN_COMPOSE_KNOB_REGISTRY));
    const fixtures = new Set(Object.keys(KNOB_FIXTURES));

    expect([...declared].filter((key) => !registry.has(key))).toEqual([]);
    expect([...registry].filter((key) => !declared.has(key))).toEqual([]);
    expect(registry).toEqual(fixtures);
  });
});
