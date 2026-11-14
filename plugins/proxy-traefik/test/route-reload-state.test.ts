import { describe, expect, test } from "bun:test";
import { createPublicKey } from "node:crypto";

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

// Leaf covering exact x.lndo.site and mapped leftmost wildcard *.lndo.site.
const mappedWildcardCertificatePem = `-----BEGIN CERTIFICATE-----
MIIBpzCCAUygAwIBAgIUUeLp7r4wZtBc5IbWDCAY5Sfp7QgwCgYIKoZIzj0EAwIw
FjEUMBIGA1UEAwwLeC5sbmRvLnNpdGUwHhcNMjYxMTA0MTAyNDU4WhcNMzYxMTAx
MTAyNDU4WjAWMRQwEgYDVQQDDAt4LmxuZG8uc2l0ZTBZMBMGByqGSM49AgEGCCqG
SM49AwEHA0IABGu03ppvzenu77M/slxjQ9lP6ORaUl0PSj0X5+orQ+YsXxwIkOIs
lZ+1blNSco9l5Z11JwbJPox1qN+L/fXU9lyjeDB2MB0GA1UdDgQWBBQYWtn2llwA
XoBamMhJ7s594B1ZBTAfBgNVHSMEGDAWgBQYWtn2llwAXoBamMhJ7s594B1ZBTAP
BgNVHRMBAf8EBTADAQH/MCMGA1UdEQQcMBqCC3gubG5kby5zaXRlggsqLmxuZG8u
c2l0ZTAKBggqhkjOPQQDAgNJADBGAiEA0kTO/eM3pHqO0P0O8Txy/mzSCHZBtC5w
Mh+mLPdbtKUCIQCkx9UOlARP+2aJ9am4A5VGEZrPFY5+pqbIPFIBJ40lLw==
-----END CERTIFICATE-----
`;
const mappedWildcardPrivateKeyPem = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgjmXa2HmmJFVvs+iX
hNc9xQ6ZDk5jp4Tbd6MvGYamRdOhRANCAARrtN6ab83p7u+zP7JcY0PZT+jkWlJd
D0o9F+fqK0PmLF8cCJDiLJWftW5TUnKPZeWddScGyT6Mdajfi/311PZc
-----END PRIVATE KEY-----
`;
const now = Date.parse("2027-01-01T00:00:00Z");

describe("certificatePairIsCurrent", () => {
  test("accepts wildcard and exact hostnames the certificate covers", () => {
    expect(
      certificatePairIsCurrent(certificatePem, privateKeyPem, {
        hostnames: ["*.demo.lndo.site", "demo.lndo.site"],
        now,
        root: certificatePem,
      }),
    ).toBe(true);
  });

  test("accepts partial leftmost route wildcards covered by a mapped *.rest SAN", () => {
    expect(
      certificatePairIsCurrent(mappedWildcardCertificatePem, mappedWildcardPrivateKeyPem, {
        hostnames: ["x.lndo.site", "*-x.lndo.site"],
        now,
        root: mappedWildcardCertificatePem,
      }),
    ).toBe(true);
  });

  test("rejects hostnames the certificate does not cover", () => {
    expect(
      certificatePairIsCurrent(certificatePem, privateKeyPem, {
        hostnames: ["*.other.lndo.site"],
        now,
        root: certificatePem,
      }),
    ).toBe(false);
    expect(
      certificatePairIsCurrent(certificatePem, privateKeyPem, {
        hostnames: ["a.b.demo.lndo.site"],
        now,
        root: certificatePem,
      }),
    ).toBe(false);
    expect(
      certificatePairIsCurrent(certificatePem, privateKeyPem, {
        hostnames: ["*.lndo.site"],
        now,
        root: certificatePem,
      }),
    ).toBe(false);
    // *-demo.lndo.site maps to *.lndo.site, which this leaf does not carry.
    expect(
      certificatePairIsCurrent(certificatePem, privateKeyPem, {
        hostnames: ["*-demo.lndo.site"],
        now,
        root: certificatePem,
      }),
    ).toBe(false);
  });

  test("rejects a public key passed as the private key", () => {
    // Given: the public half of the certificate's own key pair
    const publicKeyPem = createPublicKey(privateKeyPem).export({ type: "spki", format: "pem" }).toString();
    // Then
    expect(
      certificatePairIsCurrent(certificatePem, publicKeyPem, {
        hostnames: ["demo.lndo.site"],
        now,
        root: certificatePem,
      }),
    ).toBe(false);
    expect(
      certificatePairIsCurrent(certificatePem, privateKeyPem, {
        hostnames: ["demo.lndo.site"],
        now,
        root: certificatePem,
      }),
    ).toBe(true);
  });

  test("rejects an expired certificate", () => {
    expect(
      certificatePairIsCurrent(certificatePem, privateKeyPem, {
        hostnames: ["demo.lndo.site"],
        now: Date.parse("2040-01-01T00:00:00Z"),
        root: certificatePem,
      }),
    ).toBe(false);
  });
});
