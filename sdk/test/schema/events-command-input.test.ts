import { describe, expect, test } from "bun:test";
import { Either, Schema } from "effect";

import { EventStep } from "@lando/sdk/schema";

const decodeOptions = [undefined, { onExcessProperty: "error" }] as const;

describe("EventCommandStep flags/args input values", () => {
  test("decodes scalar and homogeneous string-array flag and arg values", () => {
    // Given
    const step = {
      command: "app:info",
      flags: {
        format: "json",
        deep: true,
        depth: 2,
        tag: ["alpha", "beta"],
      },
      args: {
        service: "appserver",
        targets: ["web", "db"],
      },
      raw: ["--verbose"],
    } as const;

    // When / Then
    for (const options of decodeOptions) {
      const decoded = Schema.decodeUnknownEither(EventStep)(step, options);
      expect(Either.isRight(decoded)).toBe(true);
      if (Either.isRight(decoded)) {
        expect(decoded.right).toEqual(step);
      }
    }
  });

  test("preserves bare string and raw-only command forms", () => {
    // Given
    const stringStep = "echo host";
    const rawOnly = { command: "app:info", raw: ["--json"] } as const;

    // When / Then
    for (const options of decodeOptions) {
      expect(Either.isRight(Schema.decodeUnknownEither(EventStep)(stringStep, options))).toBe(true);
      expect(Either.isRight(Schema.decodeUnknownEither(EventStep)(rawOnly, options))).toBe(true);
    }
  });

  test("rejects object, boolean-array, and mixed-array flag or arg values", () => {
    // Given
    const invalid = [
      { command: "app:info", flags: { meta: { nested: true } } },
      { command: "app:info", flags: { enabled: [true, false] } },
      { command: "app:info", flags: { tag: ["a", 1] } },
      { command: "app:info", flags: { tag: ["a", true] } },
      { command: "app:info", args: { service: { name: "web" } } },
      { command: "app:info", args: { ports: [80, "443"] } },
      { command: "app:info", args: { ready: [true] } },
    ] as const;

    // When / Then
    for (const options of decodeOptions) {
      for (const step of invalid) {
        expect(Either.isLeft(Schema.decodeUnknownEither(EventStep)(step, options))).toBe(true);
      }
    }
  });
});
