import { describe, expect, test } from "bun:test";

import { REDACTED, createSecretRedactor, isUsableExactRedactionValue } from "@lando/sdk/secrets";
import { LOG_LINE_TRUNCATED_MARKER } from "../../src/log-follow/marker.ts";

describe("createSecretRedactor", () => {
  for (const value of ["a", "red", "acted]", "[", "]", "x[redacted]y"]) {
    test(`treats existing sentinels as opaque when masking ${value}`, () => {
      // Given
      const redactor = createSecretRedactor([value]);
      const input = `x[redacted]y ${value} [redacted]`;
      const expected = value.includes(REDACTED) ? input : "x[redacted]y [redacted] [redacted]";
      // When
      const output = redactor.redact(input);
      const bounded = redactor.redactBounded?.(input, 1_024);
      // Then
      expect(output).toBe(expected);
      expect(bounded).toBe(expected);
      expect(redactor.redact(output)).toBe(output);
    });
  }

  test("keeps newly inserted sentinels opaque to shorter known values", () => {
    // Given
    const redactor = createSecretRedactor(["long-value", "a", "red"]);
    // When
    const output = redactor.redact("long-value a red [redacted]");
    // Then
    expect(output).toBe("[redacted] [redacted] [redacted] [redacted]");
    expect(redactor.redactBounded?.("long-value a red [redacted]", 1_024)).toBe(output);
  });

  test("masks proper prefixes before every truncation marker in both paths", () => {
    // Given
    const redactor = createSecretRedactor(["private-credential", "[redacted]suffix"]);
    const input = `private${LOG_LINE_TRUNCATED_MARKER} and priv${LOG_LINE_TRUNCATED_MARKER} [redacted]${LOG_LINE_TRUNCATED_MARKER}`;
    const expected = `[redacted]${LOG_LINE_TRUNCATED_MARKER} and [redacted]${LOG_LINE_TRUNCATED_MARKER} [redacted]${LOG_LINE_TRUNCATED_MARKER}`;
    // When
    const output = redactor.redact(input);
    const bounded = redactor.redactBounded?.(input, 1_024);
    // Then
    expect(output).toBe(expected);
    expect(bounded).toBe(expected);
    expect(redactor.redact(output)).toBe(output);
  });

  test("rejects truncation-prefix expansion when its UTF-8 output exceeds the budget", () => {
    // Given
    const redactor = createSecretRedactor(["private-credential"]);
    const input = `private${LOG_LINE_TRUNCATED_MARKER}`;
    const expected = `[redacted]${LOG_LINE_TRUNCATED_MARKER}`;
    const bytes = new TextEncoder().encode(expected).byteLength;
    // When
    const exact = redactor.redactBounded?.(input, bytes);
    const overBudget = redactor.redactBounded?.(input, bytes - 1);
    // Then
    expect(exact).toBe(expected);
    expect(overBudget).toBeUndefined();
  });

  test("masks a single occurrence of a secret value", () => {
    const redactor = createSecretRedactor(["s3cr3t"]);
    expect(redactor.redact("token=s3cr3t")).toBe(`token=${REDACTED}`);
  });

  test("masks every occurrence of a secret value", () => {
    const redactor = createSecretRedactor(["abc"]);
    expect(redactor.redact("abc and abc again")).toBe(`${REDACTED} and ${REDACTED} again`);
  });

  test("masks multiple distinct secret values", () => {
    const redactor = createSecretRedactor(["alpha", "beta"]);
    expect(redactor.redact("alpha-beta")).toBe(`${REDACTED}-${REDACTED}`);
  });

  test("masks the longest value first so overlapping substrings do not leak", () => {
    // "secret" is a substring of "secret-token"; longest-first prevents a
    // partial "secret" mask leaving "-token" exposed.
    const redactor = createSecretRedactor(["secret", "secret-token"]);
    expect(redactor.redact("x secret-token y")).toBe(`x ${REDACTED} y`);
  });

  test("leaves non-matching text unchanged", () => {
    const redactor = createSecretRedactor(["nope"]);
    expect(redactor.redact("nothing to redact")).toBe("nothing to redact");
  });

  test("ignores empty and whitespace-only secret values (never over-masks)", () => {
    const redactor = createSecretRedactor(["", "   ", "real"]);
    expect(redactor.redact("a real b")).toBe(`a ${REDACTED} b`);
    expect(redactor.redact("untouched")).toBe("untouched");
  });

  test("treats secret values literally (no regex interpretation)", () => {
    const redactor = createSecretRedactor(["a.b*c"]);
    expect(redactor.redact("value=a.b*c done")).toBe(`value=${REDACTED} done`);
    expect(redactor.redact("value=axbyc done")).toBe("value=axbyc done");
  });

  test("is idempotent on already-redacted text", () => {
    const redactor = createSecretRedactor(["pw"]);
    const once = redactor.redact("pw");
    expect(redactor.redact(once)).toBe(once);
  });

  test("exposes a REDACTED sentinel constant", () => {
    expect(typeof REDACTED).toBe("string");
    expect(REDACTED.length).toBeGreaterThan(0);
  });

  test("ignores CSI-parameter tokens so SGR sequences stay intact", () => {
    expect(isUsableExactRedactionValue("0")).toBe(false);
    expect(isUsableExactRedactionValue("1")).toBe(false);
    expect(isUsableExactRedactionValue("32")).toBe(false);
    expect(isUsableExactRedactionValue("95")).toBe(false);
    expect(isUsableExactRedactionValue("0;1")).toBe(false);
    expect(isUsableExactRedactionValue("38;2;255;0;0")).toBe(false);
    expect(isUsableExactRedactionValue("12345678")).toBe(true);
    expect(isUsableExactRedactionValue("a")).toBe(true);
    expect(isUsableExactRedactionValue("pw")).toBe(true);
    expect(isUsableExactRedactionValue("plan-secret")).toBe(true);
    const ESC = String.fromCharCode(27);
    const painted = `${ESC}[32mok${ESC}[0m`;
    const redactor = createSecretRedactor(["32", "95", "0", "1"]);
    expect(redactor.redact(painted)).toBe(painted);
    expect(redactor.redact(painted)).not.toContain("]m");
    expect(createSecretRedactor(["12345678"]).redact("pin 12345678")).toBe(`pin ${REDACTED}`);
    expect(createSecretRedactor(["a"]).redact("x a y")).toBe(`x ${REDACTED} y`);
  });
});
