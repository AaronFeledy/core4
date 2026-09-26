import { expect, test } from "bun:test";

test.each([
  { stderr: "not signed in", reason: "unauthenticated" },
  { stderr: "please sign in", reason: "unauthenticated" },
  { stderr: "app is locked", reason: "locked" },
  { stderr: "permission denied; item not found", reason: "denied" },
  { stderr: "no access to vault", reason: "denied" },
  { stderr: "unknown diagnostic", reason: "denied" },
])("classifies unavailable diagnostic $stderr", async ({ stderr, reason }) => {
  // Given
  const { classifyOpFailure } = await import("../src/classify.ts");
  // When
  const result = classifyOpFailure({ exitCode: 1, stderr, timedOut: false, cliMissing: false });
  // Then
  expect(result).toEqual({ kind: "unavailable", reason });
});

test.each(["isn't an item", "couldn't find item", "field not found"])(
  "classifies missing secret %s",
  async (stderr) => {
    // Given
    const { classifyOpFailure } = await import("../src/classify.ts");
    // When
    const result = classifyOpFailure({ exitCode: 1, stderr, timedOut: false, cliMissing: false });
    // Then
    expect(result).toEqual({ kind: "not-found" });
  },
);

test.each([
  { timedOut: true, cliMissing: false, reason: "timeout" },
  { timedOut: false, cliMissing: true, reason: "cli-missing" },
])("transport evidence takes precedence for $reason", async ({ timedOut, cliMissing, reason }) => {
  // Given
  const { classifyOpFailure } = await import("../src/classify.ts");
  // When
  const result = classifyOpFailure({ exitCode: 1, stderr: "item not found", timedOut, cliMissing });
  // Then
  expect(result).toEqual({ kind: "unavailable", reason });
});
