import { describe, expect, test } from "bun:test";

import { ComposeServiceKnobKey } from "@lando/sdk/schema";

import { composeKnobsForDialect } from "../src/podman/compose-knobs.ts";
import { KNOB_FIXTURES_BY_DIALECT } from "./compose-knobs-fixtures.ts";

const DIALECTS = ["libpod", "docker"] as const;

const expectedKnobs = (dialect: (typeof DIALECTS)[number]) => {
  const fixtureKeys = new Set(Object.keys(KNOB_FIXTURES_BY_DIALECT[dialect]));
  return ComposeServiceKnobKey.literals.filter((key) => fixtureKeys.has(key));
};

describe("Podman-backed Compose knob declarations", () => {
  for (const dialect of DIALECTS) {
    test(`Given the published ${dialect} knob list, When compared to the realization fixtures, Then it matches exactly`, () => {
      // Given / When
      const published = composeKnobsForDialect(dialect);

      // Then: providers publish this list verbatim, so any drift here is a capability lie.
      expect(published).toEqual(expectedKnobs(dialect));
    });
  }

  test("Given the published knob list, When read twice, Then callers get independent copies in canonical order", () => {
    // Given / When
    const first = composeKnobsForDialect("libpod");
    const second = composeKnobsForDialect("libpod");
    const order = expectedKnobs("libpod");

    // Then
    expect(first).not.toBe(second);
    expect(first).toEqual([...first].sort((a, b) => order.indexOf(a) - order.indexOf(b)));
  });
});
