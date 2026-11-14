import { X509Certificate, createPrivateKey } from "node:crypto";
import { isIP } from "node:net";

/** Apply-time leaf renewal margin, capped by the verifier at one third of leaf lifetime. */
export const LEAF_RENEWAL_MARGIN_MS = 30 * 24 * 60 * 60 * 1000;

export interface CertificatePair {
  /** PEM of the leaf certificate. */
  readonly certificate: string;
  /** PEM of the leaf's private key. */
  readonly privateKey: string;
}

export interface CertificatePairCurrencyOptions {
  /** Certificate names the leaf must cover: DNS names, leftmost `*.` wildcards, or IP literals. */
  readonly names: ReadonlyArray<string>;
  /** Epoch milliseconds to judge the validity window at. */
  readonly now: number;
  /**
   * Treat the leaf as stale this long before it expires. Capped at a third of the
   * leaf's lifetime, so a short-lived leaf is not stale as soon as it is issued.
   */
  readonly renewalMarginMs?: number;
  /** PEM of a root; when given, the leaf must be issued and signed by it. */
  readonly root?: string;
}

const covers = (certificate: X509Certificate, name: string): boolean => {
  if (isIP(name) !== 0) return certificate.checkIP(name) !== undefined;
  // A literal wildcard request is covered only by that wildcard SAN itself, never by a host under it.
  if (name.startsWith("*.")) {
    return certificate.checkHost(name, { wildcards: false, subject: "never" }) !== undefined;
  }
  return certificate.checkHost(name) !== undefined;
};

/**
 * Whether an existing leaf pair can keep serving `names` at `now`: the
 * certificate parses, is inside its validity window minus the renewal margin,
 * covers every name (extra names on the certificate are fine), the private key
 * belongs to it, and, when `root` is given, that root issued and signed it.
 * Unparsable material is never current; this function does not throw.
 */
export const certificatePairIsCurrent = (
  pair: CertificatePair,
  options: CertificatePairCurrencyOptions,
): boolean => {
  try {
    const certificate = new X509Certificate(pair.certificate);
    const validFrom = Date.parse(certificate.validFrom);
    const validTo = Date.parse(certificate.validTo);
    if (!Number.isFinite(validFrom) || !Number.isFinite(validTo)) return false;
    const margin = Math.min(options.renewalMarginMs ?? 0, (validTo - validFrom) / 3);
    if (options.now < validFrom || options.now + margin >= validTo) return false;
    if (!options.names.every((name) => covers(certificate, name))) return false;
    if (!certificate.checkPrivateKey(createPrivateKey(pair.privateKey))) return false;
    if (options.root === undefined) return true;
    const root = new X509Certificate(options.root);
    return certificate.checkIssued(root) && certificate.verify(root.publicKey);
  } catch {
    return false;
  }
};
