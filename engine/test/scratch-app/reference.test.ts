import { describe, expect, test } from "bun:test";
import { Result } from "effect";
import { resolveScratchReference } from "../../src/scratch-app/reference.ts";

const entries = [
  "scratch-review-aaaaaa",
  "scratch-review-bbbbbb",
  "scratch-my-app-cccccc",
  "scratch-reviewer-dddddd",
  "scratch-api-eeeeee",
  "scratch-a-name-much-longer-than-t-ffffff",
].map((id) => ({ id }));

const resolve = (reference: string, from: ReadonlyArray<{ readonly id: string }> = entries) =>
  resolveScratchReference(from, reference);

describe("resolveScratchReference", () => {
  const selected: ReadonlyArray<readonly [string, string, string]> = [
    ["an exact id", "scratch-review-aaaaaa", "scratch-review-aaaaaa"],
    ["a unique --name", "reviewer", "scratch-reviewer-dddddd"],
    ["a --name the id generator sanitized", "My App", "scratch-my-app-cccccc"],
    [
      "a --name the id generator shortened",
      "a-name-much-longer-than-the-base",
      "scratch-a-name-much-longer-than-t-ffffff",
    ],
  ];
  for (const [label, reference, id] of selected)
    test(`selects the scratch for ${label}`, () => {
      expect(Result.getOrThrow(resolve(reference)).id).toBe(id);
    });

  test("prefers an exact id over a scratch started with that string as its name", () => {
    const named = [{ id: "scratch-scratch-api-eeeeee-ffffff" }, { id: "scratch-api-eeeeee" }];
    expect(Result.getOrThrow(resolve("scratch-api-eeeeee", named)).id).toBe("scratch-api-eeeeee");
  });

  test("lists every scratch started with a shared name instead of picking one", () => {
    const failure = Result.flip(resolve("review")).pipe(Result.getOrThrow);
    expect(failure).toMatchObject({
      _tag: "ScratchAppNotFoundError",
      id: "review",
      suggestions: ["scratch-review-aaaaaa", "scratch-review-bbbbbb"],
    });
    expect(failure.remediation).toContain("scratch-review-aaaaaa");
  });

  test("suggests ids that share the reference's prefix when nothing matches", () => {
    const failure = Result.flip(resolve("revi")).pipe(Result.getOrThrow);
    expect(failure.suggestions).toEqual([
      "scratch-review-aaaaaa",
      "scratch-review-bbbbbb",
      "scratch-reviewer-dddddd",
    ]);
    expect(Result.flip(resolve("scratch-my-app-c")).pipe(Result.getOrThrow).suggestions).toEqual([
      "scratch-my-app-cccccc",
    ]);
    expect(failure.remediation).toContain("scratch:list");
  });

  test("reports no suggestions when no registered scratch is close", () => {
    expect(Result.flip(resolve("zzz")).pipe(Result.getOrThrow).suggestions).toEqual([]);
  });
});
