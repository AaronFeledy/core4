import { describe, expect, test } from "bun:test";
import { Either, Schema } from "effect";

import {
  COMPOSE_DEPRECATED_TOP_LEVEL_KEYS,
  COMPOSE_EXTENSION_TOP_LEVEL_PATTERN,
  COMPOSE_TOP_LEVEL_KEYS,
  LandofileShape,
} from "@lando/sdk/schema";

import { composeTopLevelDispositions } from "../src/compose/dispositions.ts";

describe("Compose top-level classification reconciliation", () => {
  test("COMPOSE_TOP_LEVEL_KEYS equals the accepted top-level disposition classification", () => {
    // Given
    const expected = new Set(
      Object.entries(composeTopLevelDispositions)
        .filter(([, entry]) => entry.disposition === "normalized" || entry.disposition === "preserved")
        .map(([key]) => key)
        .filter((key) => key !== COMPOSE_EXTENSION_TOP_LEVEL_PATTERN)
        .filter((key) => COMPOSE_DEPRECATED_TOP_LEVEL_KEYS.every((deprecatedKey) => deprecatedKey !== key)),
    );

    // When
    const actual = new Set<string>(COMPOSE_TOP_LEVEL_KEYS);

    // Then
    expect(actual).toEqual(expected);
  });

  test("every rejected top-level disposition is rejected by production schema decode", () => {
    // Given
    const rejectedKeys = Object.entries(composeTopLevelDispositions)
      .filter(([, entry]) => entry.disposition === "rejected")
      .map(([key]) => key);
    const decode = Schema.decodeUnknownEither(LandofileShape);

    // Then
    expect(rejectedKeys.length).toBeGreaterThan(0);
    for (const key of rejectedKeys) {
      // When
      const decoded = decode({ [key]: {} }, { onExcessProperty: "error" });

      // Then
      expect(Either.isLeft(decoded), key).toBe(true);
    }
  });

  test("the extension pattern matches the matrix wildcard key", () => {
    // Given
    const matrixKeys = new Set(Object.keys(composeTopLevelDispositions));

    // When / Then
    expect(COMPOSE_EXTENSION_TOP_LEVEL_PATTERN).toBe("x-*");
    expect(matrixKeys.has(COMPOSE_EXTENSION_TOP_LEVEL_PATTERN)).toBe(true);
  });

  test("every accepted top-level key decodes through LandofileShape", () => {
    // Given
    const minimalValues: Readonly<Record<string, unknown>> = {
      name: "compose-reconciliation",
      services: {},
      volumes: {},
      networks: {},
      configs: {},
      secrets: {},
      include: [],
    };
    const decode = Schema.decodeUnknownEither(LandofileShape);

    expect(COMPOSE_TOP_LEVEL_KEYS.length).toBeGreaterThan(0);
    for (const key of COMPOSE_TOP_LEVEL_KEYS) {
      // When
      const decoded = decode({ [key]: minimalValues[key] });

      // Then
      expect(Either.isRight(decoded), key).toBe(true);
    }
  });
});
