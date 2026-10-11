import { Schema } from "effect";

import { AppPlan } from "../schema/app-plan.ts";
import { AppRef } from "../schema/networking.ts";
import { ServiceName } from "../schema/primitives.ts";
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

export const PreRestartEvent = Schema.TaggedStruct("pre-restart", {
  scope: Schema.Literal("app").annotate({ description: "App lifecycle scope." }),
  app: AppRef.annotate({ description: "App being restarted." }),
  plan: AppPlan.annotate({ description: "Resolved app plan." }),
  triggeredBy: Schema.String.annotate({ description: "Command that triggered the restart." }),
  timestamp: Timestamp.annotate({ description: "Time the restart bracket opened." }),
  services: Schema.optionalKey(Schema.Array(ServiceName)).annotate({
    description: "Selected services for a scoped restart. Omitted for a full-app restart.",
  }),
});
export type PreRestartEvent = typeof PreRestartEvent.Type;

export const PostRestartEvent = Schema.TaggedStruct("post-restart", {
  scope: Schema.Literal("app").annotate({ description: "App lifecycle scope." }),
  app: AppRef.annotate({ description: "App being restarted." }),
  plan: AppPlan.annotate({ description: "Resolved app plan." }),
  timestamp: Timestamp.annotate({ description: "Time the restart bracket closed." }),
  services: Schema.optionalKey(Schema.Array(ServiceName)).annotate({
    description: "Selected services for a scoped restart. Omitted for a full-app restart.",
  }),
});
export type PostRestartEvent = typeof PostRestartEvent.Type;

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
