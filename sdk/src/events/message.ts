import { Schema } from "effect";

import { Timestamp } from "./_shared.ts";

export const MessageInfoEvent = Schema.TaggedStruct("message.info", {
  body: Schema.String,
  timestamp: Timestamp,
});
export type MessageInfoEvent = typeof MessageInfoEvent.Type;

export const MessageWarnEvent = Schema.TaggedStruct("message.warn", {
  body: Schema.String,
  timestamp: Timestamp,
});
export type MessageWarnEvent = typeof MessageWarnEvent.Type;

export const MessageErrorEvent = Schema.TaggedStruct("message.error", {
  body: Schema.String,
  remediation: Schema.optional(Schema.String),
  timestamp: Timestamp,
});
export type MessageErrorEvent = typeof MessageErrorEvent.Type;
