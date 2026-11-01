import { expect, test } from "bun:test";
import { PATTERN_CLASSES, REDACTED, createRedactor } from "@lando/sdk/secrets";

test.each(["secretAssignment", "signedQueryParam"])(
  "exported %s pattern exempts only complete unquoted placeholders",
  (name) => {
    const pattern = PATTERN_CLASSES[name];
    if (pattern === undefined || typeof pattern.replace !== "function")
      throw new Error("Missing pattern replacement");
    const prefix = name === "secretAssignment" ? "token=" : "?token=";
    for (const value of ["${TOKEN}", "${TOKEN?}"]) {
      const input = prefix + value;
      expect(input.replace(pattern.pattern, pattern.replace)).toBe(input);
    }
    for (const value of [
      "${TOKEN}canary",
      "${TOKEN?}canary",
      '"${TOKEN}"',
      "\\${TOKEN}",
      "${bad canary}",
      "${BAD-NAME}",
      "${TOKEN",
      "${TOKEN??}",
    ]) {
      const output = (prefix + value).replace(pattern.pattern, pattern.replace);
      expect(output).toContain(REDACTED);
      expect(output).not.toContain("canary");
      expect(output).not.toContain("TOKEN");
    }
  },
);

test.each(["secrets", "telemetry", "transcript"] as const)(
  "registered placeholder literals stay authoritative for %s",
  (profile) => {
    for (const options of [{ values: ["${TOKEN}"] }, { authoritativeValues: ["${TOKEN}"] }]) {
      const redactor = createRedactor(profile, options);
      const input = "token=${TOKEN}";
      expect(redactor.redactString(input)).toBe(`token=${REDACTED}`);
      expect(redactor.redactStringBounded?.(input, 4096) ?? redactor.redactString(input)).toBe(
        `token=${REDACTED}`,
      );
    }
  },
);

test("object secret fields remain masked even when they contain a placeholder", () => {
  expect(createRedactor("secrets").redactValue({ token: "${TOKEN}" })).toEqual({ token: REDACTED });
});

test("bounded assignments share complete-placeholder and malformed-value behavior", () => {
  const redactor = createRedactor("secrets");
  for (const value of [
    "${TOKEN}",
    "${TOKEN?}",
    "${TOKEN}canary",
    '"${TOKEN}"',
    "\\${TOKEN}",
    "${bad canary}",
    "${TOKEN",
  ]) {
    const input = `token=${value}`;
    expect(redactor.redactStringBounded?.(input, 4096)).toBe(redactor.redactString(input));
  }
});
