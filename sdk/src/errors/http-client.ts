import { Schema } from "effect";

const HttpTrustErrorKind = Schema.Literal(
  "proxy-authentication",
  "tls-interception",
  "missing-custom-ca",
  "blocked-endpoint",
);

export class HttpRequestError extends Schema.TaggedError<HttpRequestError>()("HttpRequestError", {
  message: Schema.String,
  urlOrigin: Schema.String,
  status: Schema.optional(Schema.Number),
  trustCause: Schema.optional(HttpTrustErrorKind),
  remediation: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Unknown),
}) {}

export class HttpUploadError extends Schema.TaggedError<HttpUploadError>()("HttpUploadError", {
  message: Schema.String,
  urlOrigin: Schema.String,
  status: Schema.optional(Schema.Number),
  remediation: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Unknown),
}) {}

export class HttpTrustError extends Schema.TaggedError<HttpTrustError>()("HttpTrustError", {
  message: Schema.String,
  urlOrigin: Schema.String,
  kind: HttpTrustErrorKind,
  remediation: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Unknown),
}) {}

export class HttpClientUnavailableError extends Schema.TaggedError<HttpClientUnavailableError>()(
  "HttpClientUnavailableError",
  {
    message: Schema.String,
    httpClientId: Schema.optional(Schema.String),
    remediation: Schema.optional(Schema.String),
  },
) {}
