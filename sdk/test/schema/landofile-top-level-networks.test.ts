import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { LandofileShape } from "@lando/sdk/schema";

const decodeLandofile = Schema.decodeUnknownSync(LandofileShape);

describe("Landofile top-level networks", () => {
  test("Given a null network, when decoded, then it canonicalizes to an empty resource config", () => {
    // Given / When
    const decoded = decodeLandofile({ networks: { mynetwork: null } });

    // Then
    expect(decoded.networks).toEqual({ mynetwork: {} });
  });

  test("Given a network object, when decoded, then its resource config remains accepted", () => {
    // Given / When
    const decoded = decodeLandofile({ networks: { mynetwork: { driver: "bridge" } } });

    // Then
    expect(decoded.networks).toEqual({ mynetwork: { driver: "bridge" } });
  });

  test("Given a null network, when strict decoding is repeated, then canonical output remains valid", () => {
    // Given
    const options = { onExcessProperty: "error" } as const;

    // When
    const first = decodeLandofile({ networks: { mynetwork: null } }, options);
    const second = decodeLandofile(first, options);

    // Then
    expect(second).toEqual(first);
  });
});
