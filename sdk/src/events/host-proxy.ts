import { Schema } from "effect";

import { AppRef } from "../schema/networking.ts";
import { Timestamp } from "./_shared.ts";

/**
 * Execution hooks inside a host-proxy child's initialized runtime, including
 * execution failures. Bootstrap and admission rejections are not execution
 * hooks; these events are not an audit trail. Payloads are redacted summaries
 * only: the request kind, canonical command id, a redacted argv summary, and the
 * remapped host cwd. Raw env values, secret-bearing argv tails, and un-redacted
 * URLs must never appear in these events.
 */

/** Redacted summary of a host-proxy request carried on the call events. */
export const HostProxyRequestRedacted = Schema.Struct({
  /** Request kind (`runLando`, `openUrl`, …). */
  kind: Schema.String,
  /** Canonical command id for a `runLando` request. */
  commandId: Schema.optional(Schema.String),
  /** Redacted argv summary. */
  argvSummary: Schema.optional(Schema.Array(Schema.String)),
  /** Remapped host-side cwd. */
  cwd: Schema.optional(Schema.String),
});
export type HostProxyRequestRedacted = typeof HostProxyRequestRedacted.Type;

export const PreHostProxyCallEvent = Schema.TaggedStruct("pre-host-proxy-call", {
  app: AppRef,
  /** Correlates the pre/post pair for one dispatched request. */
  callId: Schema.String,
  request: HostProxyRequestRedacted,
  /** Reported caller service, not an authenticated identity. */
  callerService: Schema.String,
  /** Nonnegative re-entry depth: an accidental-loop guard, not authorization. */
  depth: Schema.Number,
  timestamp: Timestamp,
});
export type PreHostProxyCallEvent = typeof PreHostProxyCallEvent.Type;

export const PostHostProxyCallEvent = Schema.TaggedStruct("post-host-proxy-call", {
  app: AppRef,
  callId: Schema.String,
  request: HostProxyRequestRedacted,
  callerService: Schema.String,
  depth: Schema.Number,
  outcome: Schema.Literals(["success", "failure"]),
  durationMs: Schema.optional(Schema.Number),
  /** Redacted one-line result summary. */
  resultSummary: Schema.optional(Schema.String),
  /** Tagged failure detail (the failure `_tag`) when `outcome` is `failure`. */
  failureDetail: Schema.optional(Schema.String),
  timestamp: Timestamp,
});
export type PostHostProxyCallEvent = typeof PostHostProxyCallEvent.Type;
