/**
 * Task-tree view-model for the default (TTY) renderer.
 *
 * This module is the pure state/view-model of the concurrent task-tree surface.
 * It keeps a fixed-size per-task ring buffer of the most recent `task.detail`
 * lines and surfaces them as a dimmed, indented panel under each running task.
 * On `task.complete` / `task.fail` the panel collapses to a single summary line;
 * on `task.tree.complete` the whole tree collapses to a passive summary.
 *
 * The view-model emits **zero terminal-control bytes**. `apply(event)` advances
 * the state machine; `frameLines()` returns the styled footer content lines and
 * `snapshot()` exposes the logical (unstyled) frame. All cursor rewind / erase /
 * repaint responsibility lives in the substrate live region (`LiveRegionController`),
 * so the "no destructive repaint on first paint" invariant is structural here.
 * The `Renderer` Live Layer wiring lives in `renderer-runtime.ts`.
 */

import type { LandoEvent } from "@lando/sdk/services";

import { formatDurationSuffix } from "./format.ts";
import { csi, styleBodyFrame, styleBottomFrame, wrapFrameLines } from "./task-tree-frame.ts";

export { csi } from "./task-tree-frame.ts";

/** Fixed ring-buffer depth for the task-detail tail panel. */
export const TASK_DETAIL_TAIL_CAPACITY = 4 as const;

/** Retained depth of the expandable full-stream tail (bounded by terminal scroll on render). */
export const TASK_DETAIL_EXPANDED_CAPACITY = 1000 as const;

/**
 * Fixed-capacity ring buffer of the most recent task-detail lines. Wraps
 * oldest-out; `lines()` returns the retained lines most-recent-last.
 */
export class TaskDetailRing {
  readonly #capacity: number;
  readonly #buffer: string[] = [];

  constructor(capacity: number = TASK_DETAIL_TAIL_CAPACITY) {
    this.#capacity = Math.max(1, Math.trunc(capacity));
  }

  push(line: string): void {
    this.#buffer.push(line);
    while (this.#buffer.length > this.#capacity) this.#buffer.shift();
  }

  lines(): ReadonlyArray<string> {
    return [...this.#buffer];
  }

  get count(): number {
    return this.#buffer.length;
  }
}

type TaskStatus = "pending" | "running" | "done" | "failed";

interface TaskState {
  readonly id: string;
  label: string;
  status: TaskStatus;
  summary: string | undefined;
  durationMs: number | undefined;
  exitCode: number | undefined;
  remediation: string | undefined;
  readonly ring: TaskDetailRing;
  readonly fullStream: TaskDetailRing;
}

interface TreeState {
  readonly parentId: string;
  readonly childCount: number;
  label: string;
  done: boolean;
  summary: string | undefined;
  succeeded: number;
  failed: number;
  durationMs: number | undefined;
}

const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const asNumber = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);

export interface TaskTreeViewModelOptions {
  /** Ring-buffer depth (defaults to {@link TASK_DETAIL_TAIL_CAPACITY}). */
  readonly detailCapacity?: number;
  /** Retained full-stream depth for the expanded view (defaults to {@link TASK_DETAIL_EXPANDED_CAPACITY}). */
  readonly expandedCapacity?: number;
  /** Terminal columns used to count wrapped physical rows for frame clearing. */
  readonly terminalColumns?: number | undefined;
  /** Live terminal columns source, read on every redraw. */
  readonly getTerminalColumns?: (() => number | undefined) | undefined;
  /** Terminal rows used to bound the expanded full-stream tail. */
  readonly terminalRows?: number | undefined;
  /** Live terminal rows source, read on every redraw. */
  readonly getTerminalRows?: (() => number | undefined) | undefined;
}

export interface TaskTreeViewModelSnapshot {
  /** Logical frame lines with no control bytes (for structural assertions). */
  readonly frameLines: ReadonlyArray<string>;
  /** Ids of tasks still running (panel still rendered). */
  readonly activeTaskIds: ReadonlyArray<string>;
}

/** Marker for a declared-but-not-yet-started child in the first-paint skeleton. */
const PENDING_MARKER = "◌";
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

type VisualStatus = "WAIT" | "RUNNING" | "ONLINE" | "CACHED" | "SKIPPED" | "BLOCKED";

const statusChip = (status: VisualStatus): string => `[${status}]`;

type CompletionStatus = "ONLINE" | "CACHED" | "SKIPPED";

// Trailing, delimited marker (`(cached)`/`(skipped)` or cockpit `· cached`/`· skipped`).
// The delimiter requirement keeps undelimited prose ("warm cache") classified ONLINE.
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

/**
 * Pure, deterministic view-model for the concurrent task-tree surface. Drive it
 * with the renderable `task.*` events via {@link TaskTreeViewModel.apply}; read
 * the current styled footer content with {@link TaskTreeViewModel.frameLines}.
 * The view-model never emits cursor/erase bytes — the substrate live region owns
 * all terminal mutation, and non-tree passthrough output is committed to
 * scrollback by the runtime wiring, not by this class.
 */
export class TaskTreeViewModel {
  readonly #detailCapacity: number;
  readonly #expandedCapacity: number;
  readonly #terminalColumns: number | undefined;
  readonly #getTerminalColumns: (() => number | undefined) | undefined;
  readonly #terminalRows: number | undefined;
  readonly #getTerminalRows: (() => number | undefined) | undefined;
  readonly #tasks = new Map<string, TaskState>();
  readonly #order: string[] = [];
  readonly #spinningTaskIds = new Set<string>();
  #spinnerFrame = 0;
  #tree: TreeState | undefined;
  #expandedTaskId: string | undefined;
  #expandedScrollOffset = 0;

  constructor(options: TaskTreeViewModelOptions = {}) {
    this.#detailCapacity = options.detailCapacity ?? TASK_DETAIL_TAIL_CAPACITY;
    this.#expandedCapacity = options.expandedCapacity ?? TASK_DETAIL_EXPANDED_CAPACITY;
    this.#terminalColumns = options.terminalColumns;
    this.#getTerminalColumns = options.getTerminalColumns;
    this.#terminalRows = options.terminalRows;
    this.#getTerminalRows = options.getTerminalRows;
  }

  /** Advance the task-tree state machine by one renderable `task.*` event. */
  apply(event: LandoEvent): void {
    this.#apply(event);
  }

  /** Styled footer content lines for the current state; SGR only, never cursor/erase bytes. */
  frameLines(): ReadonlyArray<string> {
    return this.#renderFrame();
  }

  treeFrameLines(): ReadonlyArray<string> {
    return this.#styleFrame(this.#renderTreeFrame());
  }

  hasAnimatedAffordance(): boolean {
    return this.#spinningTaskIds.size > 0;
  }

  showSpinner(taskId: string): void {
    if (this.#tasks.get(taskId)?.status === "running") this.#spinningTaskIds.add(taskId);
  }

  hideSpinner(taskId: string): void {
    this.#spinningTaskIds.delete(taskId);
  }

  advanceSpinner(): void {
    this.#spinnerFrame = (this.#spinnerFrame + 1) % SPINNER_FRAMES.length;
  }

  get expandedTaskId(): string | undefined {
    return this.#expandedTaskId;
  }

  focusableTaskIds(): ReadonlyArray<string> {
    return this.#order.filter((id) => {
      const task = this.#tasks.get(id);
      return task !== undefined && task.status !== "pending";
    });
  }

  canExpandTask(taskId: string): boolean {
    const status = this.#tasks.get(taskId)?.status;
    return status !== undefined && status !== "pending";
  }

  expandTask(taskId: string): void {
    if (!this.canExpandTask(taskId)) return;
    this.#expandedTaskId = taskId;
    this.#expandedScrollOffset = 0;
  }

  /** Collapse any expanded task back to the concurrent tree view (state only). */
  collapse(): void {
    this.#expandedTaskId = undefined;
    this.#expandedScrollOffset = 0;
  }

  scrollExpandedLines(delta: number): boolean {
    const task = this.#expandedTask();
    if (task === undefined) return false;
    const maxOffset = Math.max(0, task.fullStream.count - this.#expandedLineBudget());
    const next = Math.max(0, Math.min(maxOffset, this.#expandedScrollOffset + delta));
    if (next === this.#expandedScrollOffset) return false;
    this.#expandedScrollOffset = next;
    return true;
  }

  scrollExpandedPage(direction: -1 | 1): boolean {
    return this.scrollExpandedLines(direction * this.#expandedLineBudget());
  }

  snapshot(): TaskTreeViewModelSnapshot {
    return {
      frameLines: this.#renderLogicalFrame(),
      activeTaskIds: this.#order.filter((id) => this.#tasks.get(id)?.status === "running"),
    };
  }

  #apply(event: LandoEvent): void {
    const record = event;
    switch (event._tag) {
      case "task.tree.start": {
        const rawChildren = Array.isArray(record.children)
          ? record.children.filter((child): child is string => typeof child === "string")
          : [];
        const seenChildren = new Set<string>();
        const children = rawChildren.filter((child) => {
          if (seenChildren.has(child)) return false;
          seenChildren.add(child);
          return true;
        });
        this.#tree = {
          parentId: asString(record.parentId) ?? "tree",
          childCount: children.length,
          label: asString(record.label) ?? "tasks",
          done: false,
          summary: undefined,
          succeeded: 0,
          failed: 0,
          durationMs: undefined,
        };
        for (const childId of children) {
          if (this.#tasks.has(childId)) continue;
          this.#order.push(childId);
          this.#tasks.set(childId, {
            id: childId,
            label: childId,
            status: "pending",
            summary: undefined,
            durationMs: undefined,
            exitCode: undefined,
            remediation: undefined,
            ring: new TaskDetailRing(this.#detailCapacity),
            fullStream: new TaskDetailRing(this.#expandedCapacity),
          });
        }
        return;
      }
      case "task.start": {
        const id = asString(record.taskId);
        if (id === undefined) return;
        if (!this.#tasks.has(id)) this.#order.push(id);
        this.#tasks.set(id, {
          id,
          label: asString(record.label) ?? id,
          status: "running",
          summary: undefined,
          durationMs: undefined,
          exitCode: undefined,
          remediation: undefined,
          ring: new TaskDetailRing(this.#detailCapacity),
          fullStream: new TaskDetailRing(this.#expandedCapacity),
        });
        return;
      }
      case "task.detail": {
        const id = asString(record.taskId);
        if (id === undefined) return;
        const task = this.#tasks.get(id);
        if (task === undefined || task.status !== "running") return;
        const stream = asString(record.stream);
        const line = asString(record.line) ?? "";
        const rendered = stream === "stderr" ? `! ${line}` : line;
        task.ring.push(rendered);
        task.fullStream.push(rendered);
        if (this.#expandedTaskId === id && this.#expandedScrollOffset > 0) {
          this.#expandedScrollOffset = Math.min(
            Math.max(0, task.fullStream.count - this.#expandedLineBudget()),
            this.#expandedScrollOffset + 1,
          );
        }
        return;
      }
      case "task.complete": {
        const id = asString(record.taskId);
        if (id === undefined) return;
        const task = this.#tasks.get(id);
        if (task === undefined) return;
        task.status = "done";
        task.summary = asString(record.summary);
        task.durationMs = asNumber(record.durationMs);
        this.#spinningTaskIds.delete(id);
        return;
      }
      case "task.fail": {
        const id = asString(record.taskId);
        if (id === undefined) return;
        const task = this.#tasks.get(id);
        if (task === undefined) return;
        task.status = "failed";
        task.summary = asString(record.summary);
        task.durationMs = asNumber(record.durationMs);
        task.exitCode = asNumber(record.exitCode);
        task.remediation = asString(record.remediation);
        this.#spinningTaskIds.delete(id);
        return;
      }
      case "task.tree.complete": {
        if (this.#tree === undefined) {
          this.#tree = {
            parentId: asString(record.parentId) ?? "tree",
            childCount: 0,
            label: asString(record.summary) ?? "tasks",
            done: true,
            summary: asString(record.summary),
            succeeded: asNumber(record.succeeded) ?? 0,
            failed: asNumber(record.failed) ?? 0,
            durationMs: asNumber(record.durationMs),
          };
          return;
        }
        this.#tree.done = true;
        this.#tree.summary = asString(record.summary);
        this.#tree.succeeded = asNumber(record.succeeded) ?? 0;
        this.#tree.failed = asNumber(record.failed) ?? 0;
        this.#tree.label = asString(record.summary) ?? this.#tree.label;
        this.#tree.durationMs = asNumber(record.durationMs);
        return;
      }
      default:
        return;
    }
  }

  #runningCount(): number {
    let running = 0;
    for (const id of this.#order) {
      if (this.#tasks.get(id)?.status === "running") running += 1;
    }
    return running;
  }

  #parentLine(): string | undefined {
    const tree = this.#tree;
    if (tree === undefined) return undefined;
    if (tree.done) {
      const label = tree.summary ?? tree.label;
      const status: VisualStatus = tree.failed > 0 ? "BLOCKED" : "ONLINE";
      return `╭─ LANDO OPS ${statusChip(status)} ${label} (${tree.succeeded} ✓ · ${tree.failed} ✗)${formatDurationSuffix(tree.durationMs)}`;
    }
    return `╭─ LANDO OPS ${statusChip("RUNNING")} ${tree.label} (${this.#runningCount()}/${tree.childCount} running)`;
  }

  #childSummaryLine(task: TaskState): string {
    if (task.status === "done") {
      const { status, label } = classifyCompletion(task.summary, task.label);
      return `│ ${statusChip(status)} ✓ ${label}${formatDurationSuffix(task.durationMs)}`;
    }
    const label = task.summary ?? task.label;
    const exitSuffix = task.exitCode === undefined ? "" : ` (exit ${task.exitCode})`;
    return `│ ${statusChip("BLOCKED")} ✗ ${label}${exitSuffix}${formatDurationSuffix(task.durationMs)}`;
  }

  #expandedTask(): TaskState | undefined {
    if (this.#expandedTaskId === undefined) return undefined;
    return this.#tasks.get(this.#expandedTaskId);
  }

  #currentTerminalRows(): number | undefined {
    return this.#getTerminalRows?.() ?? this.#terminalRows;
  }

  #expandedLineBudget(): number {
    const rows = this.#currentTerminalRows();
    return rows === undefined ? this.#expandedCapacity : Math.max(0, rows - 3);
  }

  #expandedPanelLines(task: TaskState): ReadonlyArray<string> {
    const all = task.fullStream.lines();
    const budget = this.#expandedLineBudget();
    if (budget === 0) return [];
    const end = Math.max(0, all.length - this.#expandedScrollOffset);
    return all.slice(Math.max(0, end - budget), end);
  }

  #renderExpandedFrame(task: TaskState): ReadonlyArray<string> {
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
          : this.#spinningTaskIds.has(task.id)
            ? SPINNER_FRAMES[this.#spinnerFrame]
            : "·";
    const lines: string[] = [
      `╭─ LANDO OPS ${statusChip(status)} expanded task tail`,
      `│ ${statusChip(status)} ${marker} ${task.label}`,
    ];
    for (const detail of this.#expandedPanelLines(task)) {
      lines.push(`│    ${detail}`);
    }
    lines.push("╰─ telemetry tail online");
    return lines;
  }

  #footerLine(): string | undefined {
    const tree = this.#tree;
    if (tree === undefined) return undefined;
    if (tree.done) {
      return `╰─ telemetry ${tree.succeeded} ONLINE · ${tree.failed} BLOCKED${formatDurationSuffix(tree.durationMs)}`;
    }
    return `╰─ telemetry ${this.#runningCount()}/${tree.childCount} RUNNING`;
  }

  // Logical frame: human content, no control bytes.
  #renderLogicalFrame(): ReadonlyArray<string> {
    const expanded = this.#expandedTask();
    if (expanded !== undefined)
      return wrapFrameLines(this.#renderExpandedFrame(expanded), this.#currentTerminalColumns());
    return this.#renderTreeFrame();
  }

  #renderTreeFrame(): ReadonlyArray<string> {
    const lines: string[] = [];
    const parent = this.#parentLine();
    if (parent !== undefined) lines.push(parent);
    for (const id of this.#order) {
      const task = this.#tasks.get(id);
      if (task === undefined) continue;
      if (task.status === "pending") {
        if (this.#tree?.done === true) continue;
        lines.push(`│ ${statusChip("WAIT")} ${PENDING_MARKER} ${task.label}`);
        continue;
      }
      if (task.status === "running") {
        const marker = this.#spinningTaskIds.has(task.id) ? SPINNER_FRAMES[this.#spinnerFrame] : "·";
        lines.push(`│ ${statusChip("RUNNING")} ${marker} ${task.label}`);
        for (const detail of task.ring.lines()) {
          lines.push(`│    ${detail}`);
        }
        continue;
      }
      lines.push(this.#childSummaryLine(task));
      if (task.status === "failed" && task.remediation !== undefined) {
        lines.push(`│    ↳ ${task.remediation}`);
      }
    }
    const footer = this.#footerLine();
    if (footer !== undefined) lines.push(footer);
    return wrapFrameLines(lines, this.#currentTerminalColumns());
  }

  // Styled frame: dims the indented detail panel rows.
  #renderFrame(): ReadonlyArray<string> {
    return this.#styleFrame(this.#renderLogicalFrame());
  }

  #styleFrame(logical: ReadonlyArray<string>): ReadonlyArray<string> {
    return logical.map((line) => {
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
  }

  #currentTerminalColumns(): number | undefined {
    return this.#getTerminalColumns?.() ?? this.#terminalColumns;
  }
}
