import { describe, expect, test } from "bun:test";

import { REDACTED, createSecretRedactor } from "@lando/sdk/secrets";

describe("createSecretRedactor", () => {
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
});
