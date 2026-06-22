import { Schema } from "effect";

import { DatasetKind, RemoteEnvId } from "../schema/remote-sync.ts";
import { Timestamp } from "./_shared.ts";

const SyncBase = {
  remote: Schema.String,
  env: RemoteEnvId,
  datasets: Schema.Array(DatasetKind),
  timestamp: Timestamp,
};

const DatasetBase = {
  remote: Schema.String,
  env: RemoteEnvId,
  dataset: DatasetKind,
  timestamp: Timestamp,
};

const PostFields = {
  outcome: Schema.Literal("success", "failure"),
  failureDetail: Schema.optional(Schema.String),
  durationMs: Schema.optional(Schema.Number),
};

export const PrePullEvent = Schema.TaggedStruct("pre-pull", {
  eventName: Schema.Literal("pre-pull"),
  ...SyncBase,
});
export type PrePullEvent = typeof PrePullEvent.Type;

export const PostPullEvent = Schema.TaggedStruct("post-pull", {
  eventName: Schema.Literal("post-pull"),
  ...SyncBase,
  ...PostFields,
});
export type PostPullEvent = typeof PostPullEvent.Type;

export const PrePushEvent = Schema.TaggedStruct("pre-push", {
  eventName: Schema.Literal("pre-push"),
  ...SyncBase,
});
export type PrePushEvent = typeof PrePushEvent.Type;

export const PostPushEvent = Schema.TaggedStruct("post-push", {
  eventName: Schema.Literal("post-push"),
  ...SyncBase,
  ...PostFields,
});
export type PostPushEvent = typeof PostPushEvent.Type;

export const PreDatasetFetchEvent = Schema.TaggedStruct("pre-dataset-fetch", {
  eventName: Schema.Literal("pre-dataset-fetch"),
  ...DatasetBase,
});
export type PreDatasetFetchEvent = typeof PreDatasetFetchEvent.Type;

export const PostDatasetFetchEvent = Schema.TaggedStruct("post-dataset-fetch", {
  eventName: Schema.Literal("post-dataset-fetch"),
  ...DatasetBase,
  ...PostFields,
});
export type PostDatasetFetchEvent = typeof PostDatasetFetchEvent.Type;

export const PreDatasetApplyEvent = Schema.TaggedStruct("pre-dataset-apply", {
  eventName: Schema.Literal("pre-dataset-apply"),
  ...DatasetBase,
});
export type PreDatasetApplyEvent = typeof PreDatasetApplyEvent.Type;

export const PostDatasetApplyEvent = Schema.TaggedStruct("post-dataset-apply", {
  eventName: Schema.Literal("post-dataset-apply"),
  ...DatasetBase,
  ...PostFields,
});
export type PostDatasetApplyEvent = typeof PostDatasetApplyEvent.Type;

export const PreDatasetCaptureEvent = Schema.TaggedStruct("pre-dataset-capture", {
  eventName: Schema.Literal("pre-dataset-capture"),
  ...DatasetBase,
});
export type PreDatasetCaptureEvent = typeof PreDatasetCaptureEvent.Type;

export const PostDatasetCaptureEvent = Schema.TaggedStruct("post-dataset-capture", {
  eventName: Schema.Literal("post-dataset-capture"),
  ...DatasetBase,
  ...PostFields,
});
export type PostDatasetCaptureEvent = typeof PostDatasetCaptureEvent.Type;

export const PreDatasetSendEvent = Schema.TaggedStruct("pre-dataset-send", {
  eventName: Schema.Literal("pre-dataset-send"),
  ...DatasetBase,
});
export type PreDatasetSendEvent = typeof PreDatasetSendEvent.Type;

export const PostDatasetSendEvent = Schema.TaggedStruct("post-dataset-send", {
  eventName: Schema.Literal("post-dataset-send"),
  ...DatasetBase,
  ...PostFields,
});
export type PostDatasetSendEvent = typeof PostDatasetSendEvent.Type;
