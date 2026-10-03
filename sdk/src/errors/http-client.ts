import { Schema } from "effect";

const HttpTrustErrorKind = Schema.Literals([
  "proxy-authentication",
  "tls-interception",
  "missing-custom-ca",
  "blocked-endpoint",
]);

/**
 * Network-trust failure used as an Effect HTTP transport cause (for example
 * TLS/CA/proxy rejection). Kept after the SDK-owned HttpClient contract was
 * replaced by Effect's `effect/http` `HttpClient`.
 */
export class HttpTrustError extends Schema.TaggedError<HttpTrustError>()("HttpTrustError", {
  message: Schema.String,
  urlOrigin: Schema.String,
  kind: HttpTrustErrorKind,
  remediation: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Unknown),
}) {}
