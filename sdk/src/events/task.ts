import { Schema } from "effect";

import { AbsolutePath } from "../schema/primitives.ts";
import { Timestamp } from "./_shared.ts";

const TaskTreeChild = Schema.Struct({
  id: Schema.String.annotate({
    description: "Task id that this child's later task.start, task.complete, and task.fail events carry.",
  }),
  label: Schema.String.annotate({
    description: "Display label for the child, shown while it is still pending.",
  }),
});
export type TaskTreeChild = typeof TaskTreeChild.Type;

export const TaskTreeStartEvent = Schema.TaggedStruct("task.tree.start", {
  parentId: Schema.String,
  label: Schema.String,
  children: Schema.Array(TaskTreeChild).annotate({
    description: "Children the tree declares, in display order, before any of them starts.",
  }),
  mode: Schema.optional(Schema.Literals(["list", "grid"])),
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
  stream: Schema.Literals(["stdout", "stderr"]),
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
  outcome: Schema.optional(
    Schema.Literals(["ok", "warn", "info"]).annotate({
      description:
        "Whether the task finished cleanly (ok), with warnings the reader should look at (warn), or with a neutral result the reader owns and that is neither success nor warning (info); absent means ok.",
    }),
  ),
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
  outcome: Schema.optional(Schema.Literals(["failure", "interrupted"])).annotate({
    description:
      "Set when the tree's work failed or was interrupted, even if no child failed; absent means the tree succeeded.",
  }),
  timestamp: Timestamp,
});
export type TaskTreeCompleteEvent = typeof TaskTreeCompleteEvent.Type;
