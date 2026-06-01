import { Schema } from "effect";

import { AppPlan, AppRef } from "../schema/index.ts";
import { Timestamp } from "./_shared.ts";

/**
 * Global lifecycle events. The `Global` scope is distinct from the per-app
 * `app` scope: every payload carries `scope: "global"` so subscribers can
 * filter global-app orchestration apart from per-app lifecycle. `app.id` is
 * literally `"global"`. `pre-global-start` / `post-global-start` fire for
 * every global-app start (including the warm `ensureRunning` no-op, signalled
 * by `cached: true`).
 */
export const GlobalStartTriggeredBy = Schema.Literal(
  "meta:global:start",
  "apps:poweroff",
  "ensure-running",
  "meta:setup",
);
export type GlobalStartTriggeredBy = typeof GlobalStartTriggeredBy.Type;

export const GlobalStopTriggeredBy = Schema.Literal("meta:global:stop", "apps:poweroff");
export type GlobalStopTriggeredBy = typeof GlobalStopTriggeredBy.Type;

export const PreGlobalStartEvent = Schema.TaggedStruct("pre-global-start", {
  scope: Schema.Literal("global"),
  app: AppRef,
  plan: AppPlan,
  triggeredBy: GlobalStartTriggeredBy,
  ensuringServices: Schema.Array(Schema.String),
  cached: Schema.Boolean,
  timestamp: Timestamp,
});
export type PreGlobalStartEvent = typeof PreGlobalStartEvent.Type;

export const PostGlobalStartEvent = Schema.TaggedStruct("post-global-start", {
  scope: Schema.Literal("global"),
  app: AppRef,
  plan: AppPlan,
  cached: Schema.Boolean,
  timestamp: Timestamp,
});
export type PostGlobalStartEvent = typeof PostGlobalStartEvent.Type;

export const PreGlobalStopEvent = Schema.TaggedStruct("pre-global-stop", {
  scope: Schema.Literal("global"),
  app: AppRef,
  triggeredBy: GlobalStopTriggeredBy,
  timestamp: Timestamp,
});
export type PreGlobalStopEvent = typeof PreGlobalStopEvent.Type;

export const PostGlobalStopEvent = Schema.TaggedStruct("post-global-stop", {
  scope: Schema.Literal("global"),
  app: AppRef,
  timestamp: Timestamp,
});
export type PostGlobalStopEvent = typeof PostGlobalStopEvent.Type;
