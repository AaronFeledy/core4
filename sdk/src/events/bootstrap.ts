import { Schema } from "effect";

import { Timestamp } from "./_shared.ts";

export const PreBootstrapMinimalEvent = Schema.TaggedStruct("pre-bootstrap-minimal", {
  timestamp: Timestamp,
});
export type PreBootstrapMinimalEvent = typeof PreBootstrapMinimalEvent.Type;

export const PostBootstrapMinimalEvent = Schema.TaggedStruct("post-bootstrap-minimal", {
  timestamp: Timestamp,
});
export type PostBootstrapMinimalEvent = typeof PostBootstrapMinimalEvent.Type;

export const PreBootstrapPluginsEvent = Schema.TaggedStruct("pre-bootstrap-plugins", {
  timestamp: Timestamp,
});
export type PreBootstrapPluginsEvent = typeof PreBootstrapPluginsEvent.Type;

export const PostBootstrapPluginsEvent = Schema.TaggedStruct("post-bootstrap-plugins", {
  timestamp: Timestamp,
});
export type PostBootstrapPluginsEvent = typeof PostBootstrapPluginsEvent.Type;

export const PreBootstrapCommandsEvent = Schema.TaggedStruct("pre-bootstrap-commands", {
  timestamp: Timestamp,
});
export type PreBootstrapCommandsEvent = typeof PreBootstrapCommandsEvent.Type;

export const PostBootstrapCommandsEvent = Schema.TaggedStruct("post-bootstrap-commands", {
  timestamp: Timestamp,
});
export type PostBootstrapCommandsEvent = typeof PostBootstrapCommandsEvent.Type;

export const PreBootstrapProviderEvent = Schema.TaggedStruct("pre-bootstrap-provider", {
  timestamp: Timestamp,
});
export type PreBootstrapProviderEvent = typeof PreBootstrapProviderEvent.Type;

export const PostBootstrapProviderEvent = Schema.TaggedStruct("post-bootstrap-provider", {
  timestamp: Timestamp,
});
export type PostBootstrapProviderEvent = typeof PostBootstrapProviderEvent.Type;

export const PreBootstrapAppEvent = Schema.TaggedStruct("pre-bootstrap-app", {
  timestamp: Timestamp,
});
export type PreBootstrapAppEvent = typeof PreBootstrapAppEvent.Type;

export const PostBootstrapAppEvent = Schema.TaggedStruct("post-bootstrap-app", {
  timestamp: Timestamp,
});
export type PostBootstrapAppEvent = typeof PostBootstrapAppEvent.Type;

export const PreBootstrapToolingEvent = Schema.TaggedStruct("pre-bootstrap-tooling", {
  timestamp: Timestamp,
});
export type PreBootstrapToolingEvent = typeof PreBootstrapToolingEvent.Type;

export const PostBootstrapToolingEvent = Schema.TaggedStruct("post-bootstrap-tooling", {
  timestamp: Timestamp,
});
export type PostBootstrapToolingEvent = typeof PostBootstrapToolingEvent.Type;

export const PostBootstrapEvent = Schema.TaggedStruct("post-bootstrap", {
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
