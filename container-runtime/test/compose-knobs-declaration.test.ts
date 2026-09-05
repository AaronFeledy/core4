import { describe, expect, test } from "bun:test";

import { ComposeServiceKnobKey } from "@lando/sdk/schema";

import { podmanComposeKnobs } from "../src/podman/compose-knobs.ts";
import { KNOB_FIXTURES } from "./compose-knobs-fixtures.ts";

const fixtureKeys = new Set(Object.keys(KNOB_FIXTURES));
const expectedKnobs = ComposeServiceKnobKey.literals.filter((key) => fixtureKeys.has(key));

describe("Podman-backed Compose knob declarations", () => {
  test("Given the published knob list, When compared to the realization fixtures, Then it matches exactly", () => {
    // Given / When
    const published = podmanComposeKnobs();

    // Then: providers publish this list verbatim, so any drift here is a capability lie.
    expect(published).toEqual(expectedKnobs);
  });

  test("Given the published knob list, When read twice, Then callers get independent copies in canonical order", () => {
    // Given / When
    const first = podmanComposeKnobs();
    const second = podmanComposeKnobs();

    // Then
    expect(first).not.toBe(second);
    expect(first).toEqual([...first].sort((a, b) => expectedKnobs.indexOf(a) - expectedKnobs.indexOf(b)));
  });

  test("Given a knob the realizer cannot map, When the declaration is read, Then it is absent", () => {
    // Given / When
    const published = new Set<string>(podmanComposeKnobs());

    // Then: the fail-closed planner gate depends on these staying undeclared.
    expect(published.has("pull_policy")).toBe(false);
    expect(published.has("gpus")).toBe(false);
    expect(published.has("deploy")).toBe(false);
  });
});
