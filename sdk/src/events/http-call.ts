import { Schema } from "effect";

import { PostCallFields, Timestamp } from "./_shared.ts";

// `urlOrigin` is a redacted scheme+host origin only; userinfo, query strings,
// credentials, and other URL details must never be published in HTTP call events.

export const PreHttpCallEvent = Schema.TaggedStruct("pre-http-call", {
  eventName: Schema.Literal("pre-http-call"),
  urlOrigin: Schema.String,
  method: Schema.optional(Schema.String),
  callerId: Schema.optional(Schema.String),
  onBehalfOf: Schema.optional(Schema.String),
  timestamp: Timestamp,
});
export type PreHttpCallEvent = typeof PreHttpCallEvent.Type;

export const PostHttpCallEvent = Schema.TaggedStruct("post-http-call", {
  eventName: Schema.Literal("post-http-call"),
  urlOrigin: Schema.String,
  method: Schema.optional(Schema.String),
  status: Schema.optional(Schema.Number),
  callerId: Schema.optional(Schema.String),
  onBehalfOf: Schema.optional(Schema.String),
  ...PostCallFields,
  timestamp: Timestamp,
});
export type PostHttpCallEvent = typeof PostHttpCallEvent.Type;
