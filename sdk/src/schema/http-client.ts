import { Schema } from "effect";

const HttpHeader = Schema.Struct({
  name: Schema.String,
  value: Schema.String,
});

export const HttpClientCapabilities = Schema.Struct({
  schemes: Schema.Array(Schema.String),
  streaming: Schema.Boolean,
  upload: Schema.Boolean,
  customCa: Schema.Boolean,
  proxyAware: Schema.Boolean,
});
export type HttpClientCapabilities = typeof HttpClientCapabilities.Type;

export const HttpRequest = Schema.Struct({
  url: Schema.String,
  method: Schema.optional(Schema.String),
  headers: Schema.optional(Schema.Array(HttpHeader)),
  allowFileSource: Schema.optional(Schema.Boolean),
  timeoutMs: Schema.optional(Schema.Number),
  callerId: Schema.optional(Schema.String),
  redactionTokens: Schema.optional(Schema.Array(Schema.String)),
});
export type HttpRequest = typeof HttpRequest.Type;

export const HttpResponse = Schema.Struct({
  status: Schema.Number,
  statusText: Schema.optional(Schema.String),
  headers: Schema.Array(HttpHeader),
  contentLength: Schema.optional(Schema.Number),
});
export type HttpResponse = typeof HttpResponse.Type;

export const HttpStreamResponse = Schema.Struct({
  status: Schema.Number,
  statusText: Schema.optional(Schema.String),
  headers: Schema.Array(HttpHeader),
});
export type HttpStreamResponse = typeof HttpStreamResponse.Type;

export const HttpUploadRequest = Schema.Struct({
  url: Schema.String,
  method: Schema.optional(Schema.String),
  headers: Schema.optional(Schema.Array(HttpHeader)),
  source: Schema.Union(
    Schema.Struct({ kind: Schema.Literal("file"), path: Schema.String }),
    Schema.Struct({ kind: Schema.Literal("inline") }),
  ),
  contentType: Schema.optional(Schema.String),
  contentLength: Schema.optional(Schema.Number),
  callerId: Schema.optional(Schema.String),
  redactionTokens: Schema.optional(Schema.Array(Schema.String)),
});
export type HttpUploadRequest = typeof HttpUploadRequest.Type;
