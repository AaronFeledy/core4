import { describe, expect, test } from "bun:test";
import { ParseResult } from "effect";

import { parseComposeByteSize } from "../../src/schema/compose-byte-size.ts";

const acceptedByteSizes = [
  { literal: "64m", expected: 67_108_864 },
  { literal: "1gb", expected: 1_073_741_824 },
  { literal: "512k", expected: 524_288 },
  { literal: "134217728", expected: 134_217_728 },
  { literal: "0", expected: 0 },
  { literal: "64M", expected: 67_108_864 },
  { literal: "1GB", expected: 1_073_741_824 },
  { literal: "512K", expected: 524_288 },
  { literal: "1024b", expected: 1024 },
  { literal: "1kb", expected: 1024 },
  { literal: "1mb", expected: 1_048_576 },
  { literal: "2g", expected: 2_147_483_648 },
  { literal: "1.5g", expected: 1_610_612_736 },
  { literal: "0.5m", expected: 524_288 },
  { literal: "1.5m", expected: 1_572_864 },
  { literal: "64 m", expected: 67_108_864 },
  { literal: "1Ki", expected: 1024 },
  { literal: "1mib", expected: 1_048_576 },
  { literal: "1GiB", expected: 1_073_741_824 },
  { literal: "2T", expected: 2_199_023_255_552 },
  { literal: "1P", expected: 1_125_899_906_842_624 },
  { literal: "64tb", expected: 70_368_744_177_664 },
  { literal: "1.1k", expected: 1126 },
] as const;

const rejectedByteSizes = [
  "",
  "-5",
  "-64m",
  "m",
  "64x",
  "+64m",
  "64xb",
  "64  m",
  "64m ",
  "64m junk",
] as const;

describe("parseComposeByteSize", () => {
  for (const { literal, expected } of acceptedByteSizes) {
    test(`Given ${JSON.stringify(literal)}, When parsed, Then returns ${expected} bytes`, () => {
      // Given / When
      const bytes = parseComposeByteSize(literal);

      // Then
      expect(bytes).toBe(expected);
      expect(Number.isInteger(bytes)).toBe(true);
    });
  }

  test('Given "64M" and "64m", When both are parsed, Then results are equal (case-insensitive)', () => {
    // Given / When
    const upper = parseComposeByteSize("64M");
    const lower = parseComposeByteSize("64m");

    // Then
    expect(upper).toBe(lower);
  });

  test("Given a parsed integer re-stringified, When parsed again, Then the value is idempotent", () => {
    // Given
    const first = parseComposeByteSize("64m");

    // When
    const second = parseComposeByteSize(String(first));

    // Then
    expect(second).toBe(first);
    expect(second).toBe(parseComposeByteSize("64m"));
  });

  for (const literal of rejectedByteSizes) {
    test(`Given ${JSON.stringify(literal)}, When parsed, Then throws ParseResult.Type with Landofile service prefix`, () => {
      // Given
      let failure: unknown;

      // When
      try {
        parseComposeByteSize(literal);
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
      expect(message.startsWith("Landofile service ")).toBe(true);
      expect(message).toContain("64m");
      expect(message).toContain("1.5g");
      expect(message).toContain("1GiB");
      expect(message).toContain("1P");
      expect(message).toContain("1gb");
      expect(message).toContain("134217728");
    });
  }
});
