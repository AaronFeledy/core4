import { describe, expect, test } from "bun:test";
import { Either, Schema } from "effect";

import { HostTerminal } from "@lando/sdk/schema";

describe("HostTerminal", () => {
  test("accepts attached terminal identity and positive dimensions", () => {
    // Given
    const input = { term: "dumb", colorterm: "truecolor", columns: 132, rows: 43 };

    // When
    const decoded = Schema.decodeUnknownEither(HostTerminal)(input, { onExcessProperty: "error" });

    // Then
    expect(Either.isRight(decoded)).toBe(true);
  });

  test.each([{ columns: 0 }, { columns: -1 }, { columns: 1.5 }, { rows: 0 }, { rows: -1 }, { rows: 1.5 }])(
    "rejects non-positive or fractional dimensions: %j",
    (input) => {
      // When
      const decoded = Schema.decodeUnknownEither(HostTerminal)(input, { onExcessProperty: "error" });

      // Then
      expect(Either.isLeft(decoded)).toBe(true);
    },
  );
});
