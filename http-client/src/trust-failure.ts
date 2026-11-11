/**
 * Network-trust classification of raw fetch failures: proxy tunnel refusals and
 * TLS certificate verification codes become `HttpTrustError`; everything else
 * (including handshake drops such as EPROTO and ECONNRESET) stays a network failure.
 */
import { HttpTrustError } from "@lando/sdk/errors";

import { withoutFetchVerboseHint } from "./fetch-message.ts";

const isProxyTunnelError = (cause: unknown): cause is Error & { code: "ERR_PROXY_TUNNEL"; status: number } =>
  cause instanceof Error &&
  "code" in cause &&
  cause.code === "ERR_PROXY_TUNNEL" &&
  "status" in cause &&
  typeof cause.status === "number";

/** Issuer/chain verification codes: a custom CA for the issuer fixes these. */
const MISSING_CA_CODES: ReadonlySet<string> = new Set([
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "CERT_UNTRUSTED",
]);

/** Validity, identity, and signature codes: adding a CA does not fix these. */
const INVALID_CERTIFICATE_CODES: ReadonlySet<string> = new Set([
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "ERROR_IN_CERT_NOT_BEFORE_FIELD",
  "ERROR_IN_CERT_NOT_AFTER_FIELD",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "HOSTNAME_MISMATCH",
  "CERT_REVOKED",
  "CERT_REJECTED",
  "INVALID_CA",
  "INVALID_PURPOSE",
  "CERT_SIGNATURE_FAILURE",
  "UNABLE_TO_DECRYPT_CERT_SIGNATURE",
  "UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY",
  "CERT_CHAIN_TOO_LONG",
  "PATH_LENGTH_EXCEEDED",
]);

const certificateTrustError = (
  url: URL,
  cause: Error,
  code: string,
  redact: (value: string) => string,
): HttpTrustError | undefined => {
  const kind = MISSING_CA_CODES.has(code)
    ? "missing-custom-ca"
    : INVALID_CERTIFICATE_CODES.has(code)
      ? "certificate-invalid"
      : undefined;
  if (kind === undefined) return undefined;
  return new HttpTrustError({
    message: redact(
      `TLS trust verification failed for ${url.origin}: ${withoutFetchVerboseHint(cause.message)} (${code})`,
    ),
    urlOrigin: url.origin,
    kind,
    remediation:
      kind === "missing-custom-ca"
        ? "Supply the issuer CA through network.ca.certs or LANDO_NETWORK_CA_CERTS."
        : "The server certificate failed verification (expired, not yet valid, wrong host, or revoked); adding a CA does not fix it. Check the host clock, whether a captive portal or proxy is rewriting TLS, or the server's certificate.",
    cause,
  });
};

export const trustFailure = (url: URL, cause: unknown, redact: (value: string) => string): unknown => {
  if (isProxyTunnelError(cause)) {
    return new HttpTrustError({
      message: redact(cause.message),
      urlOrigin: url.origin,
      kind: cause.status === 407 ? "proxy-authentication" : "proxy-tunnel-refused",
      remediation: `Proxy answered ${cause.status}; check network.proxy / HTTPS_PROXY credentials or add the host to network.proxy.noProxy / NO_PROXY.`,
      cause,
    });
  }
  if (!(cause instanceof Error) || !("code" in cause) || typeof cause.code !== "string") return cause;
  return certificateTrustError(url, cause, cause.code, redact) ?? cause;
};
