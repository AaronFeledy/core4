import { describe, expect, test } from "bun:test";

import { type CertificatePair, certificatePairIsCurrent } from "@lando/sdk/certificates";
import { TEST_CERTIFICATES } from "@lando/sdk/test";

const SERVICE_NAMES = ["web", "web.app.internal", "localhost", "127.0.0.1"];
const DAY_MS = 24 * 60 * 60 * 1000;
const { validFrom, validTo, shortLivedValidTo } = TEST_CERTIFICATES;
const now = validFrom + DAY_MS;

const current = (
  pair: CertificatePair,
  options: Partial<Parameters<typeof certificatePairIsCurrent>[1]> = {},
): boolean => certificatePairIsCurrent(pair, { names: SERVICE_NAMES, now, ...options });

describe("certificatePairIsCurrent", () => {
  test("accepts a pair that covers every name inside its validity window", () => {
    expect(current(TEST_CERTIFICATES.service)).toBe(true);
  });

  describe("unusable material", () => {
    test.each([
      ["an unparsable certificate", { ...TEST_CERTIFICATES.service, certificate: "not a certificate" }],
      ["an unparsable private key", { ...TEST_CERTIFICATES.service, privateKey: "not a key" }],
      [
        "a public key in place of the private key",
        { ...TEST_CERTIFICATES.service, privateKey: TEST_CERTIFICATES.servicePublicKey },
      ],
      [
        "the private key of another pair",
        { ...TEST_CERTIFICATES.service, privateKey: TEST_CERTIFICATES.serviceRenewed.privateKey },
      ],
    ])("rejects %s without throwing", (_label, pair) => {
      expect(current(pair)).toBe(false);
    });

    test("rejects an unparsable root without throwing", () => {
      expect(current(TEST_CERTIFICATES.service, { root: "not a root" })).toBe(false);
    });
  });

  describe("validity window", () => {
    test.each([
      ["one millisecond before validFrom", validFrom - 1, false],
      ["exactly at validFrom", validFrom, true],
      ["one millisecond before validTo", validTo - 1, true],
      ["exactly at validTo", validTo, false],
      ["after validTo", validTo + DAY_MS, false],
    ])("%s", (_label, at, expected) => {
      expect(current(TEST_CERTIFICATES.service, { now: at })).toBe(expected);
    });

    test("treats the renewal margin before validTo as stale, with the boundary on the stale side", () => {
      const margin = 30 * DAY_MS;
      expect(current(TEST_CERTIFICATES.service, { now: validTo - margin - 1, renewalMarginMs: margin })).toBe(
        true,
      );
      expect(current(TEST_CERTIFICATES.service, { now: validTo - margin, renewalMarginMs: margin })).toBe(
        false,
      );
    });

    test("caps the margin at a third of the lifetime, so a fresh three-day leaf is current", () => {
      // Given: a 30-day margin against a leaf that lives three days
      const pair = TEST_CERTIFICATES.serviceShortLived;
      const lifetime = shortLivedValidTo - validFrom;
      const margin = 30 * DAY_MS;
      // Then: freshly issued it is current, and it turns stale one third of its lifetime before expiry
      expect(current(pair, { now: validFrom, renewalMarginMs: margin })).toBe(true);
      expect(current(pair, { now: shortLivedValidTo - lifetime / 3 - 1, renewalMarginMs: margin })).toBe(
        true,
      );
      expect(current(pair, { now: shortLivedValidTo - lifetime / 3, renewalMarginMs: margin })).toBe(false);
    });
  });

  describe("name coverage", () => {
    test("rejects a DNS name the certificate does not carry", () => {
      expect(current(TEST_CERTIFICATES.service, { names: [...SERVICE_NAMES, "api.app.internal"] })).toBe(
        false,
      );
    });

    test("accepts a single-label name", () => {
      expect(current(TEST_CERTIFICATES.service, { names: ["web"] })).toBe(true);
    });

    test("matches IPv4 and IPv6 literals by address, whatever the spelling", () => {
      const pair = TEST_CERTIFICATES.ipAddresses;
      expect(current(pair, { names: ["192.0.2.10"] })).toBe(true);
      expect(current(pair, { names: ["2001:db8::1"] })).toBe(true);
      expect(current(pair, { names: ["2001:0DB8:0:0:0:0:0:1"] })).toBe(true);
      expect(current(pair, { names: ["192.0.2.11"] })).toBe(false);
      expect(current(pair, { names: ["2001:db8::2"] })).toBe(false);
    });

    test("covers a literal wildcard request only with that wildcard SAN", () => {
      const pair = TEST_CERTIFICATES.contract;
      expect(current(pair, { names: ["*.test.lndo.site", "test.lndo.site"] })).toBe(true);
      expect(current(pair, { names: ["*.lndo.site"] })).toBe(false);
    });

    test("covers a host one label under a wildcard SAN", () => {
      expect(current(TEST_CERTIFICATES.contract, { names: ["app.test.lndo.site"] })).toBe(true);
      expect(current(TEST_CERTIFICATES.contract, { names: ["a.b.test.lndo.site"] })).toBe(false);
    });

    test("does not cover a wildcard request with a certificate that only names a host", () => {
      expect(current(TEST_CERTIFICATES.service, { names: ["*.app.internal"] })).toBe(false);
    });

    test("stays current when the certificate also names something no longer requested", () => {
      expect(current(TEST_CERTIFICATES.serviceExtraName)).toBe(true);
    });
  });

  describe("root", () => {
    test("accepts a leaf the given root issued and signed", () => {
      expect(current(TEST_CERTIFICATES.service, { root: TEST_CERTIFICATES.rootA })).toBe(true);
    });

    test("rejects a leaf another root with the same subject signed", () => {
      expect(current(TEST_CERTIFICATES.serviceFromRootB, { root: TEST_CERTIFICATES.rootA })).toBe(false);
      expect(current(TEST_CERTIFICATES.serviceFromRootB, { root: TEST_CERTIFICATES.rootB })).toBe(true);
    });
  });
});
