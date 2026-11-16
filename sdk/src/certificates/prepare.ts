import { Clock, Effect, Redacted } from "effect";
import { CaError } from "../errors/index.ts";
import type { CertificateAuthorityShape } from "../services/certificate-authority.ts";
import { LEAF_RENEWAL_MARGIN_MS, certificatePairIsCurrent } from "./currency.ts";
import type { CertificatePairPreparation, PreparedCertificatePair } from "./schema.ts";

/** Prepare complete material without filesystem access or publication side effects. */
export const prepareCertificatePair = Effect.fn("Certificates.preparePair")(function* (
  authority: Pick<CertificateAuthorityShape, "id" | "issueCert">,
  request: CertificatePairPreparation,
): Effect.fn.Return<PreparedCertificatePair, CaError> {
  const names = [...new Set([...request.spec.sans, request.spec.cn])];
  const now = yield* Clock.currentTimeMillis;
  if (
    request.existing !== undefined &&
    certificatePairIsCurrent(
      { certificate: request.existing.certificate, privateKey: Redacted.value(request.existing.privateKey) },
      { names, now, root: request.root, renewalMarginMs: LEAF_RENEWAL_MARGIN_MS },
    )
  ) {
    return { source: "reused", ...request.existing, root: request.root };
  }
  const issued = yield* authority.issueCert(request.spec);
  const issuedAt = yield* Clock.currentTimeMillis;
  if (
    !certificatePairIsCurrent(
      { certificate: issued.certificate, privateKey: Redacted.value(issued.privateKey) },
      { names, now: issuedAt, root: issued.root.certificate, renewalMarginMs: LEAF_RENEWAL_MARGIN_MS },
    )
  ) {
    return yield* Effect.fail(
      new CaError({
        message: `Certificate authority ${authority.id} issued a certificate for ${request.subject} that Lando cannot use: it does not cover the requested names, does not match its private key, is outside its validity window, or is not signed by the root the authority reports.`,
        caId: authority.id,
        remediation: `Repair or reinstall the ${authority.id} certificate authority with \`lando setup\`, then retry. If it keeps happening, report it to the plugin that provides the ${authority.id} certificate authority.`,
      }),
    );
  }
  return {
    source: "issued",
    certificate: issued.certificate,
    privateKey: issued.privateKey,
    root: issued.root.certificate,
  };
});
