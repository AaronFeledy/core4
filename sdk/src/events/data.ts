import { Schema } from "effect";

import { ArchiveFormat, VolumeRef } from "../schema/data-transfer.ts";
import { AppId, ServiceName } from "../schema/primitives.ts";
import { Timestamp } from "./_shared.ts";

const TransferPostFields = {
  outcome: Schema.Literal("success", "failure"),
  accelerated: Schema.Boolean,
  sizeBytes: Schema.optional(Schema.Number),
  digest: Schema.optional(Schema.String),
  failureDetail: Schema.optional(Schema.String),
  durationMs: Schema.optional(Schema.Number),
};

export const PreDataTransferEvent = Schema.TaggedStruct("pre-data-transfer", {
  eventName: Schema.Literal("pre-data-transfer"),
  fromEndpoint: Schema.String,
  toEndpoint: Schema.String,
  app: Schema.optional(AppId),
  service: Schema.optional(ServiceName),
  timestamp: Timestamp,
});
export type PreDataTransferEvent = typeof PreDataTransferEvent.Type;

export const DataTransferProgressEvent = Schema.TaggedStruct("data-transfer-progress", {
  eventName: Schema.Literal("data-transfer-progress"),
  fromEndpoint: Schema.String,
  toEndpoint: Schema.String,
  transferredBytes: Schema.Number,
  totalBytes: Schema.optional(Schema.Number),
  digest: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
  timestamp: Timestamp,
});
export type DataTransferProgressEvent = typeof DataTransferProgressEvent.Type;

export const PostDataTransferEvent = Schema.TaggedStruct("post-data-transfer", {
  eventName: Schema.Literal("post-data-transfer"),
  fromEndpoint: Schema.String,
  toEndpoint: Schema.String,
  ...TransferPostFields,
  timestamp: Timestamp,
});
export type PostDataTransferEvent = typeof PostDataTransferEvent.Type;

export const PreVolumeSnapshotEvent = Schema.TaggedStruct("pre-volume-snapshot", {
  eventName: Schema.Literal("pre-volume-snapshot"),
  volume: VolumeRef,
  format: Schema.optional(ArchiveFormat),
  timestamp: Timestamp,
});
export type PreVolumeSnapshotEvent = typeof PreVolumeSnapshotEvent.Type;

export const PostVolumeSnapshotEvent = Schema.TaggedStruct("post-volume-snapshot", {
  eventName: Schema.Literal("post-volume-snapshot"),
  volume: VolumeRef,
  snapshotId: Schema.String,
  outcome: Schema.Literal("success", "failure"),
  digest: Schema.optional(Schema.String),
  sizeBytes: Schema.optional(Schema.Number),
  failureDetail: Schema.optional(Schema.String),
  timestamp: Timestamp,
});
export type PostVolumeSnapshotEvent = typeof PostVolumeSnapshotEvent.Type;
