import { Schema } from "effect";

import { AppPlan, AppRef } from "../schema/index.ts";
import { Timestamp } from "./_shared.ts";

export const PreInitEvent = Schema.TaggedStruct("pre-init", {
  app: AppRef,
  timestamp: Timestamp,
});
export type PreInitEvent = typeof PreInitEvent.Type;

export const PostInitEvent = Schema.TaggedStruct("post-init", {
  app: AppRef,
  timestamp: Timestamp,
});
export type PostInitEvent = typeof PostInitEvent.Type;

export const PreStartEvent = Schema.TaggedStruct("pre-start", {
  scope: Schema.Literal("app"),
  app: AppRef,
  plan: AppPlan,
  triggeredBy: Schema.String,
  timestamp: Timestamp,
});
export type PreStartEvent = typeof PreStartEvent.Type;

export const PostStartEvent = Schema.TaggedStruct("post-start", {
  scope: Schema.Literal("app"),
  app: AppRef,
  plan: AppPlan,
  timestamp: Timestamp,
});
export type PostStartEvent = typeof PostStartEvent.Type;

export const PreStopEvent = Schema.TaggedStruct("pre-stop", {
  scope: Schema.Literal("app"),
  app: AppRef,
  timestamp: Timestamp,
});
export type PreStopEvent = typeof PreStopEvent.Type;

export const PostStopEvent = Schema.TaggedStruct("post-stop", {
  scope: Schema.Literal("app"),
  app: AppRef,
  timestamp: Timestamp,
});
export type PostStopEvent = typeof PostStopEvent.Type;

export const PreRebuildEvent = Schema.TaggedStruct("pre-rebuild", {
  app: AppRef,
  timestamp: Timestamp,
});
export type PreRebuildEvent = typeof PreRebuildEvent.Type;

export const PostRebuildEvent = Schema.TaggedStruct("post-rebuild", {
  app: AppRef,
  timestamp: Timestamp,
});
export type PostRebuildEvent = typeof PostRebuildEvent.Type;

export const PreDestroyEvent = Schema.TaggedStruct("pre-destroy", {
  app: AppRef,
  timestamp: Timestamp,
});
export type PreDestroyEvent = typeof PreDestroyEvent.Type;

export const PostDestroyEvent = Schema.TaggedStruct("post-destroy", {
  app: AppRef,
  timestamp: Timestamp,
});
export type PostDestroyEvent = typeof PostDestroyEvent.Type;
