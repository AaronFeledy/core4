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
  method: Schema.optionalKey(Schema.String),
  headers: Schema.optionalKey(Schema.Array(HttpHeader)),
  allowFileSource: Schema.optionalKey(Schema.Boolean),
  offline: Schema.optionalKey(Schema.Boolean),
  timeoutMs: Schema.optionalKey(Schema.Number),
  redirect: Schema.optionalKey(Schema.Literals(["follow", "error", "manual"])),
  callerId: Schema.optionalKey(Schema.String),
  onBehalfOf: Schema.optionalKey(Schema.String),
  redactionTokens: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type HttpRequest = typeof HttpRequest.Type;

export const HttpResponse = Schema.Struct({
  status: Schema.Number,
  statusText: Schema.optionalKey(Schema.String),
  headers: Schema.Array(HttpHeader),
  contentLength: Schema.optionalKey(Schema.Number),
});
export type HttpResponse = typeof HttpResponse.Type;

export const HttpStreamResponse = Schema.Struct({
  status: Schema.Number,
  statusText: Schema.optionalKey(Schema.String),
  headers: Schema.Array(HttpHeader),
});
export type HttpStreamResponse = typeof HttpStreamResponse.Type;

export const HttpUploadRequest = Schema.Struct({
  url: Schema.String,
  method: Schema.optionalKey(Schema.String),
  headers: Schema.optionalKey(Schema.Array(HttpHeader)),
  source: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("file"), path: Schema.String }),
    Schema.Struct({ kind: Schema.Literal("inline") }),
  ]),
  contentType: Schema.optionalKey(Schema.String),
  contentLength: Schema.optionalKey(Schema.Number),
  callerId: Schema.optionalKey(Schema.String),
  onBehalfOf: Schema.optionalKey(Schema.String),
  redactionTokens: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type HttpUploadRequest = typeof HttpUploadRequest.Type;
