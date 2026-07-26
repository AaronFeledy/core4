import { describe, expect, test } from "bun:test";
import { ParseResult } from "effect";

import { parseComposeDuration } from "../../src/schema/compose-duration.ts";

// Contract choice: mirror parseShortVolume with `(literal: string): number`.
// The helper returns seconds or throws ParseResult.Type for transformOrFail callers.

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
const rejectedDurations = [
  { literal: "", messageLiteral: '""' },
  { literal: "30", messageLiteral: "30" },
  { literal: "30 seconds", messageLiteral: "30 seconds" },
  { literal: "-5s", messageLiteral: "-5s" },
  { literal: "5x", messageLiteral: "5x" },
  { literal: "s", messageLiteral: "s" },
  { literal: overflowingDuration, messageLiteral: overflowingDuration },
] as const;

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

  for (const { literal, messageLiteral } of rejectedDurations) {
    test(`rejects ${messageLiteral} with the literal and accepted grammar in the remediation`, () => {
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
      const message = String(failure);
      expect(message).toContain(messageLiteral);
      expect(["30s", "1m30s", "1h2m3s"].some((example) => message.includes(example))).toBe(true);
    });
  }
});

describe("Landofile remediation surfacing", () => {
  test.each([" 30 seconds", "-5s", "5x", ""])(
    "prefixes %p failures so core's Landofile formatter surfaces the remediation",
    (literal) => {
      // core/src/landofile/service.ts only reports a nested issue's message when it
      // starts with this prefix; otherwise the user sees the bare key path instead.
      expect(() => parseComposeDuration(literal)).toThrow(/^Landofile service /u);
    },
  );
});
