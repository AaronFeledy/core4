import { Schema } from "effect";

/**
 * Network-trust failure kinds. `missing-custom-ca` is an issuer/chain
 * verification failure a custom CA can fix; `certificate-invalid` is a
 * validity, identity, or signature failure (expired, wrong host, revoked)
 * that adding a CA does not fix.
 */
export const HttpTrustErrorKind = Schema.Literals([
  "proxy-authentication",
  "proxy-tunnel-refused",
  "tls-interception",
  "missing-custom-ca",
  "certificate-invalid",
  "blocked-endpoint",
]);
export type HttpTrustErrorKind = typeof HttpTrustErrorKind.Type;

/**
 * Network-trust failure used as an Effect HTTP transport cause (for example
 * TLS/CA/proxy rejection). Kept after the SDK-owned HttpClient contract was
 * replaced by Effect's `effect/http` `HttpClient`.
 */
export class HttpTrustError extends Schema.TaggedError<HttpTrustError>()("HttpTrustError", {
  message: Schema.String,
  urlOrigin: Schema.String,
  kind: HttpTrustErrorKind,
  remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)),
  cause: Schema.optional(Schema.Unknown),
}) {}
