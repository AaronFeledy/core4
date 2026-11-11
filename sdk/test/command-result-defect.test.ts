import { expect, test } from "bun:test";
import { normalizeDefect, taggedErrorJson } from "@lando/sdk/command-result";
import { LandoInternalError, RecipeSourceError } from "@lando/sdk/errors";

test("a tagged error raised as a defect keeps its own tag and remediation", () => {
  // Given a well-formed tagged error that reached the boundary as a defect.
  const raised = new RecipeSourceError({
    kind: "missing-url",
    source: "git",
    message: "lando init --source=git requires --url=<git-url>.",
    remediation: "Pass --url=<git-url> with --source=git.",
  });
  // When the boundary normalizes the defect.
  const normalized = normalizeDefect(raised);
  // Then it is unchanged, so the user keeps the real tag and guidance.
  expect(normalized).toBe(raised);
});

test.each([
  ["a plain Error", new Error("boom")],
  ["a string", "boom"],
  ["an object with a tag but no remediation", { _tag: "SomethingError", message: "boom" }],
  ["an object with a blank remediation", { _tag: "SomethingError", message: "boom", remediation: "  " }],
])("%s becomes a LandoInternalError without its stack", (_label, defect) => {
  // Given an unexpected defect that is not a well-formed tagged error.
  // When the boundary normalizes it.
  const normalized = normalizeDefect(defect);
  // Then it is an internal error with a reporting remediation and no stack text.
  expect(normalized).toBeInstanceOf(LandoInternalError);
  expect(JSON.stringify(taggedErrorJson(normalized))).not.toMatch(/\n\s+at /u);
});
