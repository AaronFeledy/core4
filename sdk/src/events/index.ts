/**
 * Lifecycle event payload schemas.
 *
 * Event scopes: Lando, App, Provider, Tooling, CLI. The `EventService`
 * publishes payloads in priority bands, with a standard cold-start sequence.
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
  app: AppRef,
  plan: AppPlan,
  triggeredBy: Schema.String,
  timestamp: Timestamp,
});
export type PreStartEvent = typeof PreStartEvent.Type;

export const PostStartEvent = Schema.TaggedStruct("post-start", {
  app: AppRef,
  plan: AppPlan,
  timestamp: Timestamp,
});
export type PostStartEvent = typeof PostStartEvent.Type;

export const PreStopEvent = Schema.TaggedStruct("pre-stop", {
  app: AppRef,
  timestamp: Timestamp,
});
export type PreStopEvent = typeof PreStopEvent.Type;

export const PostStopEvent = Schema.TaggedStruct("post-stop", {
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
 * Open a parent container around N concurrent sibling tasks. Callers MAY
 * emit task trees as long as they publish a matching
 * {@link TaskTreeCompleteEvent} when the children finish.
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
 * Streaming tail of a single task's output. The renderer MUST treat the
 * `line` as already-redacted by the publisher.
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
 * Typed app-output records published after lifecycle steps. The renderer
 * decides how to present them (§8.9). `message.info` / `message.warn` are
 * informational and MUST NOT change a command's exit code on their own —
 * exit codes are owned by the command-effect failure channel. `message.error`
 * is non-fatal by itself for the same reason; commands that need a non-zero
 * exit MUST fail the surrounding Effect with a tagged error (which is what
 * carries the canonical remediation rendered alongside the message).
 *
 * Publishers redact body text before publishing; renderers treat the body
 * (and optional remediation) as already-redacted strings.
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
