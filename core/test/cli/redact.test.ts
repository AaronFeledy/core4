import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { registerRedactionValues, resetRegisteredRedactionValuesForTesting } from "@lando/redaction/service";
import { Effect } from "effect";

import { redactDetails, redactString } from "../../src/cli/redact.ts";

beforeEach(() => {
  resetRegisteredRedactionValuesForTesting();
});

afterEach(() => {
  resetRegisteredRedactionValuesForTesting();
});

describe("redactString", () => {
  test("redacts exact values registered after the shim is imported", () => {
    // Given
    Effect.runSync(registerRedactionValues(["opaque-canary-1252"]));
    // When
    const out = redactString("provider failed with opaque-canary-1252; retry lando setup");
    // Then
    expect(out).toBe("provider failed with [redacted]; retry lando setup");
  });

  test("observes exact values registered after its first use", () => {
    // Given
    redactString("initial provider check");
    Effect.runSync(registerRedactionValues(["later-canary-1252"]));
    // When
    const out = redactString("provider failed with later-canary-1252");
    // Then
    expect(out).toBe("provider failed with [redacted]");
  });

  test("redacts env-style secrets", () => {
    const out = redactString("setup failed HTTP_PROXY_PASSWORD=super-secret returned 1");
    expect(out).toContain("HTTP_PROXY_PASSWORD=[redacted]");
    expect(out).not.toContain("super-secret");
  });

  test("redacts credentials embedded in a proxy URL authority", () => {
    const out = redactString("proxy connect failed for http://corp-user:hunter2@proxy.example:3128");
    expect(out).toContain("http://[redacted]@proxy.example:3128");
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("corp-user");
  });

  test("redacts bearer tokens echoed in HTTP errors", () => {
    const out = redactString("401 Unauthorized: Authorization: Bearer abc123.def456");
    expect(out).toContain("Bearer [redacted]");
    expect(out).not.toContain("abc123.def456");
  });

  test("redacts secret-bearing query params in signed download URLs", () => {
    const out = redactString(
      "download failed https://github.com/lando/x/releases/download/v1/a.tgz?token=ABC123&X-Amz-Signature=deadbeef",
    );
    expect(out).toContain("token=[redacted]");
    expect(out).toContain("Signature=[redacted]");
    expect(out).not.toContain("ABC123");
    expect(out).not.toContain("deadbeef");
  });

  test("does not redact innocuous query params that merely contain a secret substring", () => {
    const out = redactString("request https://example.test/search?design=blue&keyword=token");
    expect(out).toBe("request https://example.test/search?design=blue&keyword=token");
  });
});

describe("redactDetails", () => {
  test("redacts late registered exact values in nested details without changing context", () => {
    // Given
    redactDetails({ evidence: ["initial provider check"] });
    Effect.runSync(registerRedactionValues(["nested-canary-1252"]));
    // When
    const out = redactDetails({
      evidence: ["failed with nested-canary-1252", { detail: "nested-canary-1252" }],
      context: { provider: "podman", retries: 2, available: false, detail: null },
    });
    // Then
    expect(out).toEqual({
      evidence: ["failed with [redacted]", { detail: "[redacted]" }],
      context: { provider: "podman", retries: 2, available: false, detail: null },
    });
  });
});
