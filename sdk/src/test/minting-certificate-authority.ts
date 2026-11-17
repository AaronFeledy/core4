/**
 * Test worlds need arbitrary certificate names without reaching host tools; fixed material from
 * `makeTestCertificateAuthority` covers only one name set. Issuance uses the Effect Clock so
 * leaves remain current when consumers check them under TestClock.
 */
import { Clock, Effect, Redacted } from "effect";

import type { CaRootCertificate, CertificateAuthorityShape } from "../services/certificate-authority.ts";
import { createX509Authority, issueX509Leaf } from "./x509-authority.ts";

export interface MintingCertificateAuthorityOptions {
  /** Authority id. A stand-in for a host default reports that default's id. */
  readonly id?: string;
}

/**
 * Reports `trusted: true` to model a configured authority without modifying the host trust store.
 */
export const makeMintingCertificateAuthority = (
  options: MintingCertificateAuthorityOptions = {},
): CertificateAuthorityShape => {
  const authority = createX509Authority();
  const root: CaRootCertificate = { certificate: authority.rootCertificate, trusted: true };
  return {
    id: options.id ?? "test-minting",
    setup: () => Effect.void,
    root: Effect.succeed(root),
    issueCert: (spec) =>
      Effect.gen(function* () {
        const leaf = issueX509Leaf(authority, spec, yield* Clock.currentTimeMillis);
        return {
          certificate: leaf.certificate,
          privateKey: Redacted.make(leaf.privateKey),
          root,
        };
      }),
  };
};
