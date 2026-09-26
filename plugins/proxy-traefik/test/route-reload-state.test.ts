import { describe, expect, test } from "bun:test";

import { certificatePairIsCurrent } from "../src/route-reload-state.ts";

// Test-only self-signed pair for demo.lndo.site and *.demo.lndo.site.
const certificatePem = `-----BEGIN CERTIFICATE-----
MIIBtTCCAVugAwIBAgIUTS19jlTQfH+sqKOHonN4u08BGfQwCgYIKoZIzj0EAwIw
GTEXMBUGA1UEAwwOZGVtby5sbmRvLnNpdGUwHhcNMjYwOTI1MTY1MDM2WhcNMzYw
OTIyMTY1MDM2WjAZMRcwFQYDVQQDDA5kZW1vLmxuZG8uc2l0ZTBZMBMGByqGSM49
AgEGCCqGSM49AwEHA0IABGtDw1LyUgLD9Npqk2bvoxBJfKkz383luZrnAi6jDchG
QeYnPvPVFcyGoOZsLxhmrciCVlnNgWDs132/vmfxX46jgYAwfjAdBgNVHQ4EFgQU
MSTzOp8lKkin9QQzNJb+doYrupswHwYDVR0jBBgwFoAUMSTzOp8lKkin9QQzNJb+
doYrupswDwYDVR0TAQH/BAUwAwEB/zArBgNVHREEJDAighAqLmRlbW8ubG5kby5z
aXRlgg5kZW1vLmxuZG8uc2l0ZTAKBggqhkjOPQQDAgNIADBFAiEAo3xWgWQLY0E6
cefiKceYdr/Mb3Ij1zw73FGR2YxaDpMCIA1pLndESRt4IMIcFHa2aKxW4dNydR0D
jEaxwmfHltuD
-----END CERTIFICATE-----
`;
const privateKeyPem = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgMnGzN6VGGwXNfYj3
VSmRrS2PB7TZrWwYkLJu3it28iOhRANCAARrQ8NS8lICw/TaapNm76MQSXypM9/N
5bma5wIuow3IRkHmJz7z1RXMhqDmbC8YZq3IglZZzYFg7Nd9v75n8V+O
-----END PRIVATE KEY-----
`;
const now = Date.parse("2027-01-01T00:00:00Z");

describe("certificatePairIsCurrent", () => {
  test("accepts wildcard and exact hostnames the certificate covers", () => {
    expect(
      certificatePairIsCurrent(certificatePem, privateKeyPem, ["*.demo.lndo.site", "demo.lndo.site"], now),
    ).toBe(true);
  });

  test("rejects hostnames the certificate does not cover", () => {
    expect(certificatePairIsCurrent(certificatePem, privateKeyPem, ["*.other.lndo.site"], now)).toBe(false);
    expect(certificatePairIsCurrent(certificatePem, privateKeyPem, ["a.b.demo.lndo.site"], now)).toBe(false);
    expect(certificatePairIsCurrent(certificatePem, privateKeyPem, ["*.lndo.site"], now)).toBe(false);
  });

  test("rejects an expired certificate", () => {
    expect(
      certificatePairIsCurrent(
        certificatePem,
        privateKeyPem,
        ["demo.lndo.site"],
        Date.parse("2040-01-01T00:00:00Z"),
      ),
    ).toBe(false);
  });
});
