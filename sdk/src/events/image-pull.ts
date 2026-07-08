import { Schema } from "effect";

import { Timestamp } from "./_shared.ts";

// `reference` is a redacted image reference: registry userinfo, credentials,
// and other secret material must be masked through the redaction primitive
// before the reference is published. Raw references must never appear here.

export const ImagePullProgressEvent = Schema.TaggedStruct("image-pull-progress", {
  eventName: Schema.Literal("image-pull-progress"),
  reference: Schema.String,
  stream: Schema.optional(Schema.String),
  current: Schema.optional(Schema.Number),
  total: Schema.optional(Schema.Number),
  timestamp: Timestamp,
});
export type ImagePullProgressEvent = typeof ImagePullProgressEvent.Type;
