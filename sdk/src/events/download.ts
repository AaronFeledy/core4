import { Schema } from "effect";

import { Timestamp } from "./_shared.ts";

// `urlOrigin` is a redacted scheme+host origin only; userinfo, query strings,
// credentials, and other URL details must never be published in download events.

export const PreDownloadEvent = Schema.TaggedStruct("pre-download", {
  eventName: Schema.Literal("pre-download"),
  urlOrigin: Schema.String,
  callerId: Schema.optional(Schema.String),
  expectedSizeBytes: Schema.optional(Schema.Number),
  timestamp: Timestamp,
});
export type PreDownloadEvent = typeof PreDownloadEvent.Type;

export const DownloadProgressEvent = Schema.TaggedStruct("download-progress", {
  eventName: Schema.Literal("download-progress"),
  urlOrigin: Schema.String,
  callerId: Schema.optional(Schema.String),
  bytesDownloaded: Schema.Number,
  totalBytes: Schema.optional(Schema.Number),
  timestamp: Timestamp,
});
export type DownloadProgressEvent = typeof DownloadProgressEvent.Type;

export const PostDownloadEvent = Schema.TaggedStruct("post-download", {
  eventName: Schema.Literal("post-download"),
  urlOrigin: Schema.String,
  callerId: Schema.optional(Schema.String),
  bytesDownloaded: Schema.optional(Schema.Number),
  fromCache: Schema.Boolean,
  sha256: Schema.optional(Schema.String),
  durationMs: Schema.optional(Schema.Number),
  outcome: Schema.Literal("success", "failure"),
  failureDetail: Schema.optional(Schema.String),
  timestamp: Timestamp,
});
export type PostDownloadEvent = typeof PostDownloadEvent.Type;
