import { describe, expect, test } from "bun:test";

import { redactString } from "../../src/cli/redact.ts";

describe("redactString", () => {
  test("redacts env-style secrets", () => {
    const out = redactString("setup failed HTTP_PROXY_PASSWORD=super-secret returned 1");
    expect(out).toContain("HTTP_PROXY_PASSWORD=[REDACTED]");
    expect(out).not.toContain("super-secret");
  });

  test("redacts credentials embedded in a proxy URL authority", () => {
    const out = redactString("proxy connect failed for http://corp-user:hunter2@proxy.example:3128");
    expect(out).toContain("http://[REDACTED]@proxy.example:3128");
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("corp-user");
  });

  test("redacts bearer tokens echoed in HTTP errors", () => {
    const out = redactString("401 Unauthorized: Authorization: Bearer abc123.def456");
    expect(out).toContain("Bearer [REDACTED]");
    expect(out).not.toContain("abc123.def456");
  });

  test("redacts secret-bearing query params in signed download URLs", () => {
    const out = redactString(
      "download failed https://github.com/lando/x/releases/download/v1/a.tgz?token=ABC123&X-Amz-Signature=deadbeef",
    );
    expect(out).toContain("token=[REDACTED]");
    expect(out).toContain("Signature=[REDACTED]");
    expect(out).not.toContain("ABC123");
    expect(out).not.toContain("deadbeef");
  });

  test("does not redact innocuous query params that merely contain a secret substring", () => {
    const out = redactString("request https://example.test/search?design=blue&keyword=token");
    expect(out).toBe("request https://example.test/search?design=blue&keyword=token");
  });
});
