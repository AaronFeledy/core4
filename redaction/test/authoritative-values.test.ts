import { expect, test } from "bun:test";
import { Effect } from "effect";
import { createStandaloneRedactor, makeRedactionService } from "../src/service.ts";

test.each(["1234", "32", "0;1"])(
  "suppresses unsafe authoritative value %s without emitting broken ANSI",
  async (value) => {
    const service = makeRedactionService();
    await Effect.runPromise(service.registerValues([value]));
    const redactor = await Effect.runPromise(service.forProfile("secrets", { authoritativeTokens: [value] }));
    const text = `\u001b[32mprovider ${value}\u001b[0m`;
    expect(redactor.redactString(text)).toBe("[redacted]");
    expect(redactor.redactStringBounded?.(text, 100)).toBe("[redacted]");
    expect(redactor.redactStringBounded?.(text, 2)).toBeUndefined();
    expect(redactor.redactValue({ detail: text, error: new Error(text) })).toEqual({
      detail: "[redacted]",
      error: { name: "Error", message: "[redacted]" },
    });
  },
);

test("standalone authoritative tokens share one longest-first value layer", () => {
  // Given
  const redactor = createStandaloneRedactor("secrets", {
    authoritativeTokens: ["shared-private-suffix", "shared", "32"],
  });
  // When
  const masked = redactor.redactString("engine said shared-private-suffix and shared");
  const suppressed = redactor.redactString("\u001b[32mprovider\u001b[0m");
  // Then
  expect(masked).toBe("engine said [redacted] and [redacted]");
  expect(suppressed).toBe("[redacted]");
});
