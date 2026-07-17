import { Schema } from "effect";

import { AbsolutePath } from "../schema/primitives.ts";
import { Timestamp } from "./_shared.ts";

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
  transcriptPath: Schema.optional(AbsolutePath),
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

/**
 * Renderer-emitted TTY input event published when the user expands a focused
 * task to its full streaming tail. Emitted by the renderer, never by callers.
 */
export const TaskDetailExpandEvent = Schema.TaggedStruct("task.detail.expand", {
  taskId: Schema.String,
  timestamp: Timestamp,
});
export type TaskDetailExpandEvent = typeof TaskDetailExpandEvent.Type;

/**
 * Renderer-emitted TTY input event published when the user collapses an
 * expanded task back to the bounded tail. Emitted by the renderer, never by callers.
 */
export const TaskDetailCollapseEvent = Schema.TaggedStruct("task.detail.collapse", {
  taskId: Schema.String,
  timestamp: Timestamp,
});
export type TaskDetailCollapseEvent = typeof TaskDetailCollapseEvent.Type;

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
