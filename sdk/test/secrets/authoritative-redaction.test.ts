import { expect, test } from "bun:test";
import { createRedactor, createSecretRedactor } from "@lando/sdk/secrets";

test("explicit short values suppress details while heuristic numeric values preserve ANSI", () => {
  const text = "\u001b[32mopaque 1234\u001b[0m";
  expect(createSecretRedactor(["32", "1234"]).redact(text)).toBe(text);
  expect(createSecretRedactor([], ["1234"]).redact(text)).toBe("[redacted]");
  expect(createSecretRedactor([], ["1234"]).redact("unaffected")).toBe("unaffected");
});

test.each(["secrets", "telemetry", "transcript"] as const)(
  "%s masks authoritative short values in nested details",
  (profile) => {
    const redactor = createRedactor(profile, { authoritativeValues: ["1234"] });
    expect(redactor.redactValue({ details: ["opaque 1234"] })).toEqual({ details: ["[redacted]"] });
  },
);
