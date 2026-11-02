import { Schema } from "effect";

import { AppPlan } from "../schema/app-plan.ts";
import { AppRef } from "../schema/networking.ts";
import { Timestamp } from "./_shared.ts";

/**
 * Global lifecycle events. The `Global` scope is distinct from the per-app
 * `app` scope: every payload carries `scope: "global"` so subscribers can
 * filter global-app orchestration apart from per-app lifecycle. `app.id` is
 * literally `"global"`. `pre-global-start` / `post-global-start` fire for
 * every global-app start (including the warm `ensureRunning` no-op, signalled
 * by `cached: true`).
 */
export const GlobalStartTriggeredBy = Schema.Literals([
  "meta:global:start",
  "apps:poweroff",
  "ensure-running",
  "meta:setup",
]);
export type GlobalStartTriggeredBy = typeof GlobalStartTriggeredBy.Type;

export const GlobalStopTriggeredBy = Schema.Literals(["meta:global:stop", "apps:poweroff"]);
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

// ============================================================================
// Global destroy brackets cover provider teardown and route cleanup.
// ============================================================================

export const PreGlobalDestroyEvent = Schema.Struct({
  _tag: Schema.tag("pre-global-destroy").annotate({
    description: "Global destroy opening event discriminator.",
  }),
  scope: Schema.Literal("global").annotate({ description: "Global lifecycle scope." }),
  app: AppRef.annotate({ description: "Global app identity being destroyed." }),
  evidence: Schema.Literals(["applied", "orphans", "owned"]).annotate({
    description:
      "Teardown evidence: an applied plan, observed orphans, or ownership inventory. Absent evidence emits no bracket.",
  }),
  purge: Schema.Boolean.annotate({
    description: "Whether app-owned volumes are removed. Global purge does not remove snapshots or caches.",
  }),
  timestamp: Timestamp.annotate({
    description: "Time the global destroy bracket opened, before destructive work.",
  }),
});
export type PreGlobalDestroyEvent = typeof PreGlobalDestroyEvent.Type;

export const PostGlobalDestroyEvent = Schema.Struct({
  _tag: Schema.tag("post-global-destroy").annotate({
    description: "Global destroy completion event discriminator.",
  }),
  scope: PreGlobalDestroyEvent.fields.scope,
  app: AppRef.annotate({ description: "Global app identity whose teardown completed." }),
  evidence: PreGlobalDestroyEvent.fields.evidence,
  purge: PreGlobalDestroyEvent.fields.purge,
  outcome: Schema.Literals(["destroyed", "unchanged"]).annotate({
    description:
      "Whether provider teardown removed resources. Published only after teardown and route cleanup both succeed.",
  }),
  timestamp: Timestamp.annotate({
    description: "Time global teardown and route cleanup completed successfully.",
  }),
});
export type PostGlobalDestroyEvent = typeof PostGlobalDestroyEvent.Type;

export const PreGlobalRebuildEvent = Schema.TaggedStruct("pre-global-rebuild", {
  scope: Schema.Literal("global"),
  app: AppRef,
  plan: AppPlan,
  timestamp: Timestamp,
});
export type PreGlobalRebuildEvent = typeof PreGlobalRebuildEvent.Type;

export const PostGlobalRebuildEvent = Schema.TaggedStruct("post-global-rebuild", {
  scope: Schema.Literal("global"),
  app: AppRef,
  plan: AppPlan,
  services: Schema.Array(Schema.String),
  timestamp: Timestamp,
});
export type PostGlobalRebuildEvent = typeof PostGlobalRebuildEvent.Type;
