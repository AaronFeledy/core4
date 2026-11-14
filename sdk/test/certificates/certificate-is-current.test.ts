import { expect, test } from "bun:test";
import { LEAF_RENEWAL_MARGIN_MS, certificateIsCurrent } from "@lando/sdk/certificates";
import { TEST_CERTIFICATES as certs } from "@lando/sdk/test";

test.each([
  [
    "a concrete host covered by another owner's wildcard",
    certs.contract.certificate,
    "app.test.lndo.site",
    certs.rootA,
    certs.validFrom,
    true,
  ],
  [
    "an uncovered host",
    certs.contract.certificate,
    "a.b.test.lndo.site",
    certs.rootA,
    certs.validFrom,
    false,
  ],
  ["an IP SAN", certs.ipAddresses.certificate, "2001:db8::1", certs.rootA, certs.validFrom, true],
  [
    "a different root with the same subject",
    certs.service.certificate,
    "web",
    certs.rootB,
    certs.validFrom,
    false,
  ],
  ["malformed material", "invalid", "web", certs.rootA, certs.validFrom, false],
  ["malformed root", certs.service.certificate, "web", "invalid", certs.validFrom, false],
  ["a future leaf", certs.service.certificate, "web", certs.rootA, certs.validFrom - 1, false],
  [
    "a leaf entering renewal",
    certs.serviceOneYear.certificate,
    "web",
    certs.rootA,
    certs.oneYearValidTo - LEAF_RENEWAL_MARGIN_MS,
    false,
  ],
  [
    "a leaf before renewal",
    certs.serviceOneYear.certificate,
    "web",
    certs.rootA,
    certs.oneYearValidTo - LEAF_RENEWAL_MARGIN_MS - 1,
    true,
  ],
  [
    "a fresh short-lived leaf",
    certs.serviceShortLived.certificate,
    "web",
    certs.rootA,
    certs.validFrom,
    true,
  ],
] as const)("judges %s without a private key", (_label, certificate, name, root, now, expected) => {
  expect(
    certificateIsCurrent(certificate, { names: [name], root, now, renewalMarginMs: LEAF_RENEWAL_MARGIN_MS }),
  ).toBe(expected);
});
