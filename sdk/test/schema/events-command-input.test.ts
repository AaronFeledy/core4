import { describe, expect, test } from "bun:test";
import { Either, Schema } from "effect";

import { EventStep } from "@lando/sdk/schema";

const decodeOptions = [undefined, { onExcessProperty: "error" }] as const;

describe("EventCommandStep flags/args input values", () => {
  test("decodes scalar and homogeneous typed-array flag and arg values", () => {
    // Given
    const step = {
      command: "app:info",
      flags: {
        format: "json",
        deep: true,
        depth: 2,
        tag: ["alpha", "beta"],
        retries: [1, 2],
        enabled: [true, false],
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

  test("decodes repeated typed command values in deferred and looped steps", () => {
    // Given
    const steps = [
      { command: "app:info", defer: true, flags: { retries: [1, 2] }, args: { enabled: [true] } },
      {
        command: "app:info",
        for: ["web", "db"],
        flags: { enabled: [true, false] },
        args: { retries: [1, 2] },
      },
    ] as const;

    // When / Then
    for (const options of decodeOptions) {
      for (const step of steps) {
        expect(Either.isRight(Schema.decodeUnknownEither(EventStep)(step, options))).toBe(true);
      }
    }
  });

  test("decodes working directories on deferred and looped cmd steps", () => {
    // Given
    const steps = [
      { defer: "cleanup", dir: "/workspace/deferred" },
      { cmd: "cleanup", defer: true, dir: "/workspace/deferred-explicit" },
      { cmd: "inspect", for: ["web", "db"], dir: "/workspace/loop" },
      { defer: "cleanup", for: ["web", "db"], dir: "/workspace/loop-deferred" },
    ] as const;

    // When / Then
    for (const options of decodeOptions) {
      for (const step of steps) {
        expect(Either.isRight(Schema.decodeUnknownEither(EventStep)(step, options))).toBe(true);
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

  test("rejects object and mixed-array flag or arg values", () => {
    // Given
    const invalid = [
      { command: "app:info", flags: { meta: { nested: true } } },
      { command: "app:info", flags: { tag: ["a", 1] } },
      { command: "app:info", flags: { tag: ["a", true] } },
      { command: "app:info", args: { service: { name: "web" } } },
      { command: "app:info", args: { ports: [80, "443"] } },
    ] as const;

    // When / Then
    for (const options of decodeOptions) {
      for (const step of invalid) {
        expect(Either.isLeft(Schema.decodeUnknownEither(EventStep)(step, options))).toBe(true);
      }
    }
  });
});
