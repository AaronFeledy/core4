import { afterEach, expect, test } from "bun:test";
import tls from "node:tls";
import { TEST_CERTIFICATES } from "@lando/sdk/test";

import { hostTrustsPem } from "../src/host-trust.ts";

const originalDefault = tls.getCACertificates("default");

afterEach(() => {
  tls.setDefaultCACertificates(originalDefault);
});

test("a root only in the process default set, like NODE_EXTRA_CA_CERTS, is not host trust (#2705)", () => {
  // Given: the process trusts the root the way NODE_EXTRA_CA_CERTS would, but the system store does not
  tls.setDefaultCACertificates([...originalDefault, TEST_CERTIFICATES.rootA]);
  expect(tls.getCACertificates("default")).toContain(TEST_CERTIFICATES.rootA);

  // When / Then
  expect(hostTrustsPem(TEST_CERTIFICATES.rootA)).toBe(false);
});
