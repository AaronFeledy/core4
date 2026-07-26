import { describe, expect, test } from "bun:test";
import { ParseResult } from "effect";

import { parseComposeDuration } from "../../src/schema/compose-duration.ts";

// Contract choice: mirror parseShortVolume with a throwing `(literal: string): number` helper for transformOrFail callers.

const acceptedDurations = [
  { literal: "30s", expected: 30 },
  { literal: "1m30s", expected: 90 },
  { literal: "1h2m3s", expected: 3723 },
  { literal: "1.5h", expected: 5400 },
  { literal: "500ms", expected: 0.5 },
  { literal: "100us", expected: 0.0001 },
  { literal: "100µs", expected: 0.0001 },
  { literal: "100μs", expected: 0.0001 },
  { literal: "1ns", expected: 0.000000001 },
  { literal: "0", expected: 0 },
  { literal: "+30s", expected: 30 },
] as const;

const overflowingDuration = `${"9".repeat(309)}h`;
const rejectedDurations = ["", "30", "30 seconds", "-5s", "5x", "s", overflowingDuration] as const;

describe("parseComposeDuration", () => {
  for (const { literal, expected } of acceptedDurations) {
    test(`decodes ${literal} to seconds`, () => {
      // Given / When
      const seconds = parseComposeDuration(literal);

      // Then
      expect(seconds).toBe(expected);
    });
  }

  test.each(acceptedDurations.filter(({ expected }) => expected > 0 && expected < 1))(
    "preserves the fractional seconds in $literal",
    ({ literal, expected }) => {
      // Given / When
      const seconds = parseComposeDuration(literal);

      // Then
      expect(seconds).toBe(expected);
      expect(Number.isInteger(seconds)).toBe(false);
    },
  );

  for (const literal of rejectedDurations) {
    test(`rejects ${JSON.stringify(literal)} with the accepted grammar in the remediation`, () => {
      // Given
      let failure: unknown;

      // When
      try {
        parseComposeDuration(literal);
      } catch (error) {
        if (error instanceof ParseResult.Type) failure = error;
        else throw error;
      }

      // Then
      expect(failure).toBeInstanceOf(ParseResult.Type);
      if (!(failure instanceof ParseResult.Type)) return;
      const message = failure.message;
      expect(message).toBeDefined();
      if (message === undefined) return;
      expect(["30s", "1m30s", "1h2m3s"].some((example) => message.includes(example))).toBe(true);
    });
  }

  test("bounds remediation for a long invalid duration", () => {
    // Given
    const literal = `attacker-${"x".repeat(4_096)}`;

    // When
    let failure: ParseResult.Type | undefined;
    try {
      parseComposeDuration(literal);
    } catch (error) {
      if (error instanceof ParseResult.Type) failure = error;
      else throw error;
    }

    // Then
    expect(failure?.message).toBeDefined();
    if (failure?.message === undefined) return;
    expect(failure.message.length).toBeLessThan(512);
    expect(failure.message).not.toContain(literal);
  });

  test("rejects a long invalid scalar without rescanning every suffix", () => {
    // Given
    const literal = "9".repeat(64_000);

    // When / Then
    expect(() => parseComposeDuration(literal)).toThrow(ParseResult.Type);
  });
});
