import type { AbsolutePath } from "@lando/sdk/schema";
import type { TaskDetailRing } from "./task-detail-ring.ts";
import { wrapFrameLines } from "./task-tree-frame.ts";
import { PENDING_MARKER, SPINNER_FRAMES, styleFrame } from "./task-tree-style.ts";

export type TaskStatus = "pending" | "running" | "done" | "failed";

export interface TaskState {
  readonly id: string;
  readonly transcriptPath: AbsolutePath | undefined;
  label: string;
  status: TaskStatus;
  summary: string | undefined;
  durationMs: number | undefined;
  exitCode: number | undefined;
  remediation: string | undefined;
  readonly ring: TaskDetailRing;
}

export interface TreeState {
  readonly parentId: string;
  readonly childCount: number;
  label: string;
  done: boolean;
  summary: string | undefined;
  succeeded: number;
  failed: number;
  durationMs: number | undefined;
}

export interface TaskTreeRenderState {
  readonly tree: TreeState | undefined;
  readonly tasks: ReadonlyMap<string, TaskState>;
  readonly order: ReadonlyArray<string>;
  readonly spinningTaskIds: ReadonlySet<string>;
  readonly spinnerFrame: number;
  readonly expandedTaskId: string | undefined;
  readonly expandedLines: ReadonlyArray<string>;
  readonly terminalColumns: number | undefined;
}

export { SPINNER_FRAMES, styleFrame };

type CompletionStatus = "ONLINE" | "CACHED" | "SKIPPED";
const COMPLETION_STATUS_MARKER = /(?:\s*\((cached|skipped)\)|\s+·\s*(cached|skipped))\s*$/i;

const assertNever = (value: never): never => {
  throw new Error(`Unexpected task-tree variant: ${String(value)}`);
};

const formatQuietDuration = (durationMs: number | undefined): string => {
  if (durationMs === undefined) return "";
  if (durationMs < 1000) return `  ${Math.round(durationMs)}ms`;
  return `  ${(durationMs / 1000).toFixed(1)}s`;
};

const classifyCompletion = (
  summary: string | undefined,
  fallbackLabel: string,
): { readonly status: CompletionStatus; readonly label: string } => {
  if (summary === undefined) return { status: "ONLINE", label: fallbackLabel };
  const match = COMPLETION_STATUS_MARKER.exec(summary);
  if (match === null) return { status: "ONLINE", label: summary };
  const marker = (match[1] ?? match[2] ?? "").toLowerCase();
  const stripped = summary.slice(0, match.index).trim();
  return {
    status: marker === "cached" ? "CACHED" : "SKIPPED",
    label: stripped.length > 0 ? stripped : fallbackLabel,
  };
};

const runningCount = (state: TaskTreeRenderState): number =>
  state.order.filter((id) => state.tasks.get(id)?.status === "running").length;

const runningMarker = (state: TaskTreeRenderState, task: TaskState): string =>
  state.spinningTaskIds.has(task.id)
    ? (SPINNER_FRAMES[state.spinnerFrame % SPINNER_FRAMES.length] ?? "·")
    : "·";

const parentLine = (state: TaskTreeRenderState): string | undefined => {
  const tree = state.tree;
  if (tree === undefined) return undefined;
  return `╭─ ${tree.done ? (tree.summary ?? tree.label) : tree.label}`;
};

const doneLine = (task: TaskState): string => {
  const { status, label } = classifyCompletion(task.summary, task.label);
  const duration = formatQuietDuration(task.durationMs);
  switch (status) {
    case "CACHED":
      return `│ ✓ ${label}  cached${duration}`;
    case "SKIPPED":
      return `│ – ${label}  skipped${duration}`;
    case "ONLINE":
      return `│ ✓ ${label}${duration}`;
    default:
      return assertNever(status);
  }
};

const childGlyphLine = (state: TaskTreeRenderState, task: TaskState): string => {
  switch (task.status) {
    case "pending":
      return `│ ${PENDING_MARKER} ${task.label}`;
    case "running":
      return `│ ${runningMarker(state, task)} ${task.label}`;
    case "done":
      return doneLine(task);
    case "failed": {
      const label = task.summary ?? task.label;
      const exitSuffix = task.exitCode === undefined ? "" : ` (exit ${task.exitCode})`;
      return `│ ✗ ${label}${exitSuffix}${formatQuietDuration(task.durationMs)}`;
    }
    default:
      return assertNever(task.status);
  }
};

const footerLine = (state: TaskTreeRenderState): string | undefined => {
  const tree = state.tree;
  if (tree === undefined) return undefined;
  if (!tree.done) return `╰─ ${runningCount(state)}/${tree.childCount} running`;
  const duration = formatQuietDuration(tree.durationMs);
  if (tree.failed === 0) return `╰─ done${duration}`;
  if (tree.succeeded === 0) return `╰─ ${tree.failed} failed${duration}`;
  return `╰─ ${tree.succeeded} ok · ${tree.failed} failed${duration}`;
};

export const renderTreeFrame = (state: TaskTreeRenderState): ReadonlyArray<string> => {
  const lines: string[] = [];
  const parent = parentLine(state);
  if (parent !== undefined) lines.push(parent);
  for (const id of state.order) {
    const task = state.tasks.get(id);
    if (task === undefined) continue;
    if (task.status === "pending" && state.tree?.done === true) continue;
    lines.push(childGlyphLine(state, task));
    if (task.status === "running") {
      for (const detail of task.ring.lines()) lines.push(`│    ${detail}`);
    }
    if (task.status === "failed" && task.remediation !== undefined) lines.push(`│    ↳ ${task.remediation}`);
  }
  const footer = footerLine(state);
  if (footer !== undefined) lines.push(footer);
  return wrapFrameLines(lines, state.terminalColumns);
};

const renderExpandedFrame = (state: TaskTreeRenderState, task: TaskState): ReadonlyArray<string> => {
  const lines = [
    `╭─ ${task.label}`,
    childGlyphLine(state, task),
    ...state.expandedLines.map((line) => `│    ${line}`),
    "╰─ tail",
  ];
  return wrapFrameLines(lines, state.terminalColumns);
};

export const renderLogicalFrame = (state: TaskTreeRenderState): ReadonlyArray<string> => {
  const expanded = state.expandedTaskId === undefined ? undefined : state.tasks.get(state.expandedTaskId);
  return expanded === undefined ? renderTreeFrame(state) : renderExpandedFrame(state, expanded);
};
