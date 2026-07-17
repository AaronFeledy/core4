import type { AbsolutePath } from "@lando/sdk/schema";
import { formatDurationSuffix } from "./format.ts";
import type { TaskDetailRing } from "./task-detail-ring.ts";
import { csi, styleBodyFrame, styleBottomFrame, wrapFrameLines } from "./task-tree-frame.ts";

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

const PENDING_MARKER = "◌";
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
type VisualStatus = "WAIT" | "RUNNING" | "ONLINE" | "CACHED" | "SKIPPED" | "BLOCKED";
type CompletionStatus = "ONLINE" | "CACHED" | "SKIPPED";
const statusChip = (status: VisualStatus): string => `[${status}]`;
const COMPLETION_STATUS_MARKER = /(?:\s*\((cached|skipped)\)|\s+·\s*(cached|skipped))\s*$/i;

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

const parentLine = (state: TaskTreeRenderState): string | undefined => {
  const tree = state.tree;
  if (tree === undefined) return undefined;
  if (tree.done) {
    const label = tree.summary ?? tree.label;
    const status: VisualStatus = tree.failed > 0 ? "BLOCKED" : "ONLINE";
    return `╭─ LANDO OPS ${statusChip(status)} ${label} (${tree.succeeded} ✓ · ${tree.failed} ✗)${formatDurationSuffix(tree.durationMs)}`;
  }
  return `╭─ LANDO OPS ${statusChip("RUNNING")} ${tree.label} (${runningCount(state)}/${tree.childCount} running)`;
};

const childSummaryLine = (task: TaskState): string => {
  if (task.status === "done") {
    const { status, label } = classifyCompletion(task.summary, task.label);
    return `│ ${statusChip(status)} ✓ ${label}${formatDurationSuffix(task.durationMs)}`;
  }
  const label = task.summary ?? task.label;
  const exitSuffix = task.exitCode === undefined ? "" : ` (exit ${task.exitCode})`;
  return `│ ${statusChip("BLOCKED")} ✗ ${label}${exitSuffix}${formatDurationSuffix(task.durationMs)}`;
};

export const renderTreeFrame = (state: TaskTreeRenderState): ReadonlyArray<string> => {
  const lines: string[] = [];
  const parent = parentLine(state);
  if (parent !== undefined) lines.push(parent);
  for (const id of state.order) {
    const task = state.tasks.get(id);
    if (task === undefined) continue;
    if (task.status === "pending") {
      if (state.tree?.done !== true) lines.push(`│ ${statusChip("WAIT")} ${PENDING_MARKER} ${task.label}`);
      continue;
    }
    if (task.status === "running") {
      const marker = state.spinningTaskIds.has(task.id) ? SPINNER_FRAMES[state.spinnerFrame] : "·";
      lines.push(`│ ${statusChip("RUNNING")} ${marker} ${task.label}`);
      for (const detail of task.ring.lines()) lines.push(`│    ${detail}`);
      continue;
    }
    lines.push(childSummaryLine(task));
    if (task.status === "failed" && task.remediation !== undefined) lines.push(`│    ↳ ${task.remediation}`);
  }
  const tree = state.tree;
  if (tree !== undefined) {
    lines.push(
      tree.done
        ? `╰─ telemetry ${tree.succeeded} ONLINE · ${tree.failed} BLOCKED${formatDurationSuffix(tree.durationMs)}`
        : `╰─ telemetry ${runningCount(state)}/${tree.childCount} RUNNING`,
    );
  }
  return wrapFrameLines(lines, state.terminalColumns);
};

const renderExpandedFrame = (state: TaskTreeRenderState, task: TaskState): ReadonlyArray<string> => {
  const status: VisualStatus =
    task.status === "done"
      ? classifyCompletion(task.summary, task.label).status
      : task.status === "failed"
        ? "BLOCKED"
        : "RUNNING";
  const marker =
    task.status === "done"
      ? "✓"
      : task.status === "failed"
        ? "✗"
        : state.spinningTaskIds.has(task.id)
          ? SPINNER_FRAMES[state.spinnerFrame]
          : "·";
  const lines = [
    `╭─ LANDO OPS ${statusChip(status)} expanded task tail`,
    `│ ${statusChip(status)} ${marker} ${task.label}`,
    ...state.expandedLines.map((line) => `│    ${line}`),
    "╰─ telemetry tail online",
  ];
  return wrapFrameLines(lines, state.terminalColumns);
};

export const renderLogicalFrame = (state: TaskTreeRenderState): ReadonlyArray<string> => {
  const expanded = state.expandedTaskId === undefined ? undefined : state.tasks.get(state.expandedTaskId);
  return expanded === undefined ? renderTreeFrame(state) : renderExpandedFrame(state, expanded);
};

export const styleFrame = (logical: ReadonlyArray<string>): ReadonlyArray<string> =>
  logical.map((line) => {
    if (line.startsWith("╭─")) return `${csi.bold}${csi.pink}${line}${csi.reset}`;
    if (line.startsWith("╰─")) return styleBottomFrame(line);
    if (line.includes(statusChip("BLOCKED"))) return styleBodyFrame(line, csi.red, csi.reset);
    if (line.includes(statusChip("CACHED"))) return styleBodyFrame(line, csi.cyan, csi.reset);
    if (line.includes(statusChip("SKIPPED")))
      return styleBodyFrame(line, `${csi.dim}${csi.cyan}`, `${csi.dimReset}${csi.reset}`);
    if (line.includes(statusChip("ONLINE"))) return styleBodyFrame(line, csi.green, csi.reset);
    if (line.includes(statusChip("WAIT"))) return styleBodyFrame(line, csi.amber, csi.reset);
    if (line.includes(statusChip("RUNNING"))) return styleBodyFrame(line, csi.cyan, csi.reset);
    if (line.startsWith("│")) return styleBodyFrame(line, csi.dim, `${csi.dimReset}${csi.reset}`);
    return line;
  });
