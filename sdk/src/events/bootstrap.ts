import { Schema } from "effect";

import { Timestamp } from "./_shared.ts";

export const PreBootstrapEvent = Schema.TaggedStruct("pre-bootstrap", {
  level: Schema.Literal("minimal", "plugins", "commands", "provider", "app", "tooling"),
  timestamp: Timestamp,
});
export type PreBootstrapEvent = typeof PreBootstrapEvent.Type;

export const PostBootstrapEvent = Schema.TaggedStruct("post-bootstrap", {
  level: Schema.Literal("minimal", "plugins", "commands", "provider", "app", "tooling"),
  timestamp: Timestamp,
});
export type PostBootstrapEvent = typeof PostBootstrapEvent.Type;

export const ReadyEvent = Schema.TaggedStruct("ready", {
  timestamp: Timestamp,
});
export type ReadyEvent = typeof ReadyEvent.Type;

export const BeforeExitEvent = Schema.TaggedStruct("before-exit", {
  exitCode: Schema.Number,
  timestamp: Timestamp,
});
export type BeforeExitEvent = typeof BeforeExitEvent.Type;
