import { Schema } from "effect";

import { AppId } from "../schema/primitives.ts";
import { TunnelStatus } from "../schema/tunnel.ts";
import { Timestamp } from "./_shared.ts";

const TunnelBase = {
  app: AppId,
  provider: Schema.String,
  sessionId: Schema.optional(Schema.String),
  targetSummary: Schema.String,
  detached: Schema.Boolean,
  publicUrlSummary: Schema.optional(Schema.String),
  timestamp: Timestamp,
};

const OutcomeFields = {
  outcome: Schema.Literal("success", "failure"),
  failureDetail: Schema.optional(Schema.String),
  durationMs: Schema.optional(Schema.Number),
};

export const PreTunnelStartEvent = Schema.TaggedStruct("pre-tunnel-start", {
  eventName: Schema.Literal("pre-tunnel-start"),
  ...TunnelBase,
});
export type PreTunnelStartEvent = typeof PreTunnelStartEvent.Type;

export const PostTunnelStartEvent = Schema.TaggedStruct("post-tunnel-start", {
  eventName: Schema.Literal("post-tunnel-start"),
  ...TunnelBase,
  ...OutcomeFields,
});
export type PostTunnelStartEvent = typeof PostTunnelStartEvent.Type;

export const TunnelReadyEvent = Schema.TaggedStruct("tunnel-ready", {
  eventName: Schema.Literal("tunnel-ready"),
  ...TunnelBase,
  status: Schema.Literal("ready"),
});
export type TunnelReadyEvent = typeof TunnelReadyEvent.Type;

export const PreTunnelStopEvent = Schema.TaggedStruct("pre-tunnel-stop", {
  eventName: Schema.Literal("pre-tunnel-stop"),
  ...TunnelBase,
});
export type PreTunnelStopEvent = typeof PreTunnelStopEvent.Type;

export const PostTunnelStopEvent = Schema.TaggedStruct("post-tunnel-stop", {
  eventName: Schema.Literal("post-tunnel-stop"),
  ...TunnelBase,
  ...OutcomeFields,
});
export type PostTunnelStopEvent = typeof PostTunnelStopEvent.Type;

export const TunnelStatusEvent = Schema.TaggedStruct("tunnel-status", {
  eventName: Schema.Literal("tunnel-status"),
  ...TunnelBase,
  status: TunnelStatus,
});
export type TunnelStatusEvent = typeof TunnelStatusEvent.Type;
