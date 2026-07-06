import { Schema } from "effect";

import { Timestamp } from "./_shared.ts";

// MCP tool-dispatch lifecycle events. Payloads are redacted summaries only:
// tool id, canonical command id, an optional redacted app-ref summary,
// outcome, duration, and a tagged failure detail. Tool inputs, result
// payloads, and secret-bearing values must never appear in these events.

export const PreMcpCallEvent = Schema.TaggedStruct("pre-mcp-call", {
  eventName: Schema.Literal("pre-mcp-call"),
  toolId: Schema.String,
  commandId: Schema.String,
  appRef: Schema.optional(Schema.String),
  timestamp: Timestamp,
});
export type PreMcpCallEvent = typeof PreMcpCallEvent.Type;

export const PostMcpCallEvent = Schema.TaggedStruct("post-mcp-call", {
  eventName: Schema.Literal("post-mcp-call"),
  toolId: Schema.String,
  commandId: Schema.String,
  appRef: Schema.optional(Schema.String),
  outcome: Schema.Literal("success", "failure"),
  durationMs: Schema.optional(Schema.Number),
  failureDetail: Schema.optional(Schema.String),
  timestamp: Timestamp,
});
export type PostMcpCallEvent = typeof PostMcpCallEvent.Type;
