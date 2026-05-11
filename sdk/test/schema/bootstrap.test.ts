import { describe, expect, test } from "bun:test";

import { Either, ParseResult, Schema } from "effect";

import { BOOTSTRAP_RANK, BootstrapLevel } from "@lando/sdk/schema";

const EXPECTED_LITERALS = [
  "none",
  "minimal",
  "plugins",
  "commands",
  "tooling",
  "provider",
  "global",
  "scratch",
  "app",
] as const;

const EXPECTED_RANK = {
  none: 0,
  minimal: 1,
  plugins: 2,
  commands: 3,
  tooling: 4,
  provider: 5,
  global: 6,
  scratch: 7,
  app: 8,
} as const;

describe("BootstrapLevel", () => {
  test("is a Schema.Literal exposing exactly the nine MVP levels", () => {
    const literals = BootstrapLevel.literals;
    expect([...literals].sort()).toEqual([...EXPECTED_LITERALS].sort());
    expect(literals).toHaveLength(EXPECTED_LITERALS.length);
  });

  test("decodes every known level successfully", () => {
    for (const level of EXPECTED_LITERALS) {
      const result = Schema.decodeUnknownEither(BootstrapLevel)(level);
      expect(Either.isRight(result)).toBe(true);
    }
  });

  test("rejects unknown literals with a structured ParseError", () => {
    const result = Schema.decodeUnknownEither(BootstrapLevel)("not-a-level");
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(ParseResult.isParseError(result.left)).toBe(true);
      expect(result.left._tag).toBe("ParseError");
      const issues = ParseResult.ArrayFormatter.formatErrorSync(result.left);
      expect(issues.length).toBeGreaterThan(0);
      for (const issue of issues) {
        expect(issue._tag).toBe("Type");
        expect(issue.message).toContain("not-a-level");
      }
    }
  });

  test("rejects non-string inputs with a structured ParseError", () => {
    const result = Schema.decodeUnknownEither(BootstrapLevel)(42);
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(ParseResult.isParseError(result.left)).toBe(true);
    }
  });
});

describe("BOOTSTRAP_RANK", () => {
  test("orders the levels exactly none(0) through app(8) — frozen contract", () => {
    expect(BOOTSTRAP_RANK).toEqual(EXPECTED_RANK);
  });

  test("covers every BootstrapLevel literal with a numeric rank", () => {
    for (const level of BootstrapLevel.literals) {
      expect(BOOTSTRAP_RANK[level]).toBe(EXPECTED_RANK[level]);
    }
  });

  test("levels are strictly monotonically ordered", () => {
    const ordered = [...BootstrapLevel.literals];
    for (let i = 1; i < ordered.length; i += 1) {
      const prev = ordered[i - 1];
      const curr = ordered[i];
      if (prev === undefined || curr === undefined) throw new Error("unreachable");
      expect(BOOTSTRAP_RANK[curr]).toBeGreaterThan(BOOTSTRAP_RANK[prev]);
    }
  });
});
