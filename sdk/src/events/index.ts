/**
 * Lifecycle event payload schemas for bootstrap, app, task,
 * message, and renderer events.
 */
import { Schema } from "effect";

import { AppPlan, AppRef, ProviderId, ServiceName } from "../schema/index.ts";

export type { AppRef };

const Timestamp = Schema.DateTimeUtc;

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

export const PreAppStartEvent = Schema.TaggedStruct("pre-app-start", {
  eventName: Schema.Literal("pre-app-start"),
  appRef: AppRef,
  providerId: ProviderId,
  timestamp: Timestamp,
});
export type PreAppStartEvent = typeof PreAppStartEvent.Type;

export const PostAppStartEvent = Schema.TaggedStruct("post-app-start", {
  eventName: Schema.Literal("post-app-start"),
  appRef: AppRef,
  providerId: ProviderId,
  timestamp: Timestamp,
});
export type PostAppStartEvent = typeof PostAppStartEvent.Type;

export const PreAppStopEvent = Schema.TaggedStruct("pre-app-stop", {
  eventName: Schema.Literal("pre-app-stop"),
  appRef: AppRef,
  providerId: ProviderId,
  timestamp: Timestamp,
});
export type PreAppStopEvent = typeof PreAppStopEvent.Type;

export const PostAppStopEvent = Schema.TaggedStruct("post-app-stop", {
  eventName: Schema.Literal("post-app-stop"),
  appRef: AppRef,
  providerId: ProviderId,
  timestamp: Timestamp,
});
export type PostAppStopEvent = typeof PostAppStopEvent.Type;

export const PreServiceStartEvent = Schema.TaggedStruct("pre-service-start", {
  eventName: Schema.Literal("pre-service-start"),
  appRef: AppRef,
  serviceName: ServiceName,
  providerId: ProviderId,
  timestamp: Timestamp,
});
export type PreServiceStartEvent = typeof PreServiceStartEvent.Type;

export const PostServiceStartEvent = Schema.TaggedStruct("post-service-start", {
  eventName: Schema.Literal("post-service-start"),
  appRef: AppRef,
  serviceName: ServiceName,
  providerId: ProviderId,
  timestamp: Timestamp,
});
export type PostServiceStartEvent = typeof PostServiceStartEvent.Type;

export const PreServiceStopEvent = Schema.TaggedStruct("pre-service-stop", {
  eventName: Schema.Literal("pre-service-stop"),
  appRef: AppRef,
  serviceName: Schema.optional(ServiceName),
  providerId: ProviderId,
  timestamp: Timestamp,
});
export type PreServiceStopEvent = typeof PreServiceStopEvent.Type;

export const PostServiceStopEvent = Schema.TaggedStruct("post-service-stop", {
  eventName: Schema.Literal("post-service-stop"),
  appRef: AppRef,
  serviceName: Schema.optional(ServiceName),
  providerId: ProviderId,
  timestamp: Timestamp,
});
export type PostServiceStopEvent = typeof PostServiceStopEvent.Type;

export const PreBuildEvent = Schema.TaggedStruct("pre-build", {
  eventName: Schema.Literal("pre-build"),
  appRef: AppRef,
  serviceName: Schema.optional(ServiceName),
  providerId: ProviderId,
  timestamp: Timestamp,
});
export type PreBuildEvent = typeof PreBuildEvent.Type;

export const PostBuildEvent = Schema.TaggedStruct("post-build", {
  eventName: Schema.Literal("post-build"),
  appRef: AppRef,
  serviceName: Schema.optional(ServiceName),
  providerId: ProviderId,
  timestamp: Timestamp,
});
export type PostBuildEvent = typeof PostBuildEvent.Type;

export const PreProviderApplyEvent = Schema.TaggedStruct("pre-provider-apply", {
  app: AppRef,
  providerId: Schema.String,
  timestamp: Timestamp,
});
export type PreProviderApplyEvent = typeof PreProviderApplyEvent.Type;

export const PostProviderApplyEvent = Schema.TaggedStruct("post-provider-apply", {
  app: AppRef,
  providerId: Schema.String,
  timestamp: Timestamp,
});
export type PostProviderApplyEvent = typeof PostProviderApplyEvent.Type;

export const PreProviderExecEvent = Schema.TaggedStruct("pre-provider-exec", {
  app: AppRef,
  service: ServiceName,
  timestamp: Timestamp,
});
export type PreProviderExecEvent = typeof PreProviderExecEvent.Type;

export const PostProviderExecEvent = Schema.TaggedStruct("post-provider-exec", {
  app: AppRef,
  service: ServiceName,
  exitCode: Schema.Number,
  timestamp: Timestamp,
});
export type PostProviderExecEvent = typeof PostProviderExecEvent.Type;

export const CliCommandInitEvent = Schema.TaggedStruct("cli-command-init", {
  commandId: Schema.String,
  timestamp: Timestamp,
});
export type CliCommandInitEvent = typeof CliCommandInitEvent.Type;

export const CliCommandRunEvent = Schema.TaggedStruct("cli-command-run", {
  commandId: Schema.String,
  timestamp: Timestamp,
});
export type CliCommandRunEvent = typeof CliCommandRunEvent.Type;

export const CliCommandErrorEvent = Schema.TaggedStruct("cli-command-error", {
  commandId: Schema.String,
  message: Schema.String,
  timestamp: Timestamp,
});
export type CliCommandErrorEvent = typeof CliCommandErrorEvent.Type;

/**
 * Start event for a grouped task tree with concurrent
 * sibling tasks.
 */
export const TaskTreeStartEvent = Schema.TaggedStruct("task.tree.start", {
  parentId: Schema.String,
  label: Schema.String,
  children: Schema.Array(Schema.String),
  mode: Schema.optional(Schema.Literal("list", "grid")),
  timestamp: Timestamp,
});
export type TaskTreeStartEvent = typeof TaskTreeStartEvent.Type;

export const TaskStartEvent = Schema.TaggedStruct("task.start", {
  taskId: Schema.String,
  parentId: Schema.optional(Schema.String),
  label: Schema.String,
  timestamp: Timestamp,
});
export type TaskStartEvent = typeof TaskStartEvent.Type;

/**
 * Streaming output for a single task. `line` is already
 * redacted by the publisher.
 */
export const TaskDetailEvent = Schema.TaggedStruct("task.detail", {
  taskId: Schema.String,
  stream: Schema.Literal("stdout", "stderr"),
  line: Schema.String,
  timestamp: Timestamp,
});
export type TaskDetailEvent = typeof TaskDetailEvent.Type;

export const TaskCompleteEvent = Schema.TaggedStruct("task.complete", {
  taskId: Schema.String,
  summary: Schema.optional(Schema.String),
  durationMs: Schema.optional(Schema.Number),
  timestamp: Timestamp,
});
export type TaskCompleteEvent = typeof TaskCompleteEvent.Type;

export const TaskFailEvent = Schema.TaggedStruct("task.fail", {
  taskId: Schema.String,
  summary: Schema.optional(Schema.String),
  exitCode: Schema.optional(Schema.Number),
  remediation: Schema.optional(Schema.String),
  durationMs: Schema.optional(Schema.Number),
  timestamp: Timestamp,
});
export type TaskFailEvent = typeof TaskFailEvent.Type;

export const TaskTreeCompleteEvent = Schema.TaggedStruct("task.tree.complete", {
  parentId: Schema.String,
  summary: Schema.optional(Schema.String),
  succeeded: Schema.Number,
  failed: Schema.Number,
  durationMs: Schema.optional(Schema.Number),
  timestamp: Timestamp,
});
export type TaskTreeCompleteEvent = typeof TaskTreeCompleteEvent.Type;

/**
 * App-output records published after lifecycle steps.
 * Renderers choose how to present them, and `body` plus
 * optional `remediation` are already-redacted strings.
 */
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

/**
 * First-paint handoff event emitted after the renderer is
 * initialized. Plain and lando renderers skip it; JSON
 * renderers emit it as one NDJSON line on stderr.
 */
export const PaintBannerEvent = Schema.TaggedStruct("paint.banner", {
  banner: Schema.String,
  timestamp: Timestamp,
});
export type PaintBannerEvent = typeof PaintBannerEvent.Type;

export const LandoEvent = Schema.Union(
  PreBootstrapEvent,
  PostBootstrapEvent,
  ReadyEvent,
  BeforeExitEvent,
  PreInitEvent,
  PostInitEvent,
  PreStartEvent,
  PostStartEvent,
  PreStopEvent,
  PostStopEvent,
  PreRebuildEvent,
  PostRebuildEvent,
  PreDestroyEvent,
  PostDestroyEvent,
  PreGlobalStartEvent,
  PostGlobalStartEvent,
  PreGlobalStopEvent,
  PostGlobalStopEvent,
  PreAppStartEvent,
  PostAppStartEvent,
  PreAppStopEvent,
  PostAppStopEvent,
  PreServiceStartEvent,
  PostServiceStartEvent,
  PreServiceStopEvent,
  PostServiceStopEvent,
  PreBuildEvent,
  PostBuildEvent,
  PreProviderApplyEvent,
  PostProviderApplyEvent,
  PreProviderExecEvent,
  PostProviderExecEvent,
  CliCommandInitEvent,
  CliCommandRunEvent,
  CliCommandErrorEvent,
  TaskTreeStartEvent,
  TaskStartEvent,
  TaskDetailEvent,
  TaskCompleteEvent,
  TaskFailEvent,
  TaskTreeCompleteEvent,
  MessageInfoEvent,
  MessageWarnEvent,
  MessageErrorEvent,
  PaintBannerEvent,
);
export type LandoEvent = typeof LandoEvent.Type;

export const SubscriberPriority = {
  critical: { min: 0, max: 9 },
  early: { min: 10, max: 99 },
  default: { min: 100, max: 999 },
  late: { min: 1000, max: 9999 },
  final: { min: 10000, max: Number.MAX_SAFE_INTEGER },
} as const;

export type SubscriberPriorityBand = keyof typeof SubscriberPriority;
