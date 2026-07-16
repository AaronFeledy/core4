/**
 * Interactive Lando-renderer task-tree tail.
 *
 * This module is the pure core of the default (TTY) renderer's concurrent
 * task-tree surface. It keeps a fixed-size per-task ring buffer of the most
 * recent `task.detail` lines and surfaces them as a dimmed, indented panel
 * under each running task. On `task.complete` / `task.fail` the panel
 * collapses to a single summary line; on `task.tree.complete` the whole tree
 * collapses to a passive summary.
 *
 * Rendering uses a **whole-frame redraw** model rather than per-panel cursor
 * accounting: the painter remembers how many terminal rows the previous frame
 * occupied, rewinds the cursor to the top of that frame, erases downward, and
 * repaints the entire active tree. This keeps the cursor invariant trivial
 * (after every write the cursor sits on a fresh line below the frame) and
 * handles concurrent stacked sibling panels without bespoke choreography.
 *
 * The painter is pure: `consume(event)` returns the exact byte chunk to write,
 * and `snapshot()` exposes the current logical frame (no control bytes) for
 * structural assertions. The `Renderer` Live Layer wiring lives in
 * `runtime.ts`; the painter core stays deterministic while runtime wiring
 * handles input subscription and event publication.
 */

import type { LandoEvent } from "@lando/sdk/services";

import { formatDurationSuffix } from "./format.ts";
import { physicalRowsForFrame, styleBodyFrame, styleBottomFrame, wrapFrameLines } from "./task-tree-frame.ts";

/** Fixed ring-buffer depth for the task-detail tail panel. */
export const TASK_DETAIL_TAIL_CAPACITY = 4 as const;

/** Retained depth of the expandable full-stream tail (bounded by terminal scroll on render). */
export const TASK_DETAIL_EXPANDED_CAPACITY = 1000 as const;

const ESC = String.fromCharCode(27);

/**
 * CSI control sequences used by the task-tree painter. Co-located here
 * because the repo intentionally ships no ANSI dependency.
 */
export const csi = {
  /** Move the cursor up `lines` rows (`ESC[<n>A`). */
  cursorUp: (lines: number): string => `${ESC}[${lines}A`,
  /** Erase the entire current line (`ESC[2K`). */
  eraseLine: `${ESC}[2K`,
  /** Erase from the cursor to the end of the line (`ESC[0K`). */
  eraseToEndOfLine: `${ESC}[0K`,
  /** Erase from the cursor to the end of the screen (`ESC[0J`). */
  eraseDown: `${ESC}[0J`,
  /** Carriage return to column 0. */
  carriageReturn: "\r",
  /** Faint / dim text on (`ESC[2m`). */
  dim: `${ESC}[2m`,
  /** Reset faint / dim text (`ESC[22m`). */
  dimReset: `${ESC}[22m`,
  bold: `${ESC}[1m`,
  reset: `${ESC}[0m`,
  cyan: `${ESC}[36m`,
  pink: `${ESC}[95m`,
  green: `${ESC}[32m`,
  amber: `${ESC}[33m`,
  red: `${ESC}[31m`,
} as const;

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

export interface LandoTreePainterOptions {
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

export interface LandoTreePainterSnapshot {
  /** Logical frame lines with no control bytes (for structural assertions). */
  readonly frameLines: ReadonlyArray<string>;
  /** Ids of tasks still running (panel still rendered). */
  readonly activeTaskIds: ReadonlyArray<string>;
}

/** Marker for a declared-but-not-yet-started child in the first-paint skeleton. */
const PENDING_MARKER = "◌";

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
 * Pure, deterministic painter for the concurrent task-tree tail. Drive it with
 * the renderable `task.*` events; non-tree output is routed through
 * {@link LandoTreePainter.passthrough} so it scrolls above the live frame
 * without corrupting the cursor.
 */
export class LandoTreePainter {
  readonly #detailCapacity: number;
  readonly #expandedCapacity: number;
  readonly #terminalColumns: number | undefined;
  readonly #getTerminalColumns: (() => number | undefined) | undefined;
  readonly #terminalRows: number | undefined;
  readonly #getTerminalRows: (() => number | undefined) | undefined;
  readonly #tasks = new Map<string, TaskState>();
  readonly #order: string[] = [];
  #tree: TreeState | undefined;
  #expandedTaskId: string | undefined;
  #lastFrame: ReadonlyArray<string> = [];

  constructor(options: LandoTreePainterOptions = {}) {
    this.#detailCapacity = options.detailCapacity ?? TASK_DETAIL_TAIL_CAPACITY;
    this.#expandedCapacity = options.expandedCapacity ?? TASK_DETAIL_EXPANDED_CAPACITY;
    this.#terminalColumns = options.terminalColumns;
    this.#getTerminalColumns = options.getTerminalColumns;
    this.#terminalRows = options.terminalRows;
    this.#getTerminalRows = options.getTerminalRows;
  }

  consume(event: LandoEvent): string {
    this.#apply(event);
    return this.#repaint();
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
    return this.#tasks.get(taskId)?.status === "running";
  }

  expandTask(taskId: string): string {
    if (!this.canExpandTask(taskId)) return "";
    this.#expandedTaskId = taskId;
    return this.#repaint();
  }

  collapse(): string {
    this.#expandedTaskId = undefined;
    return this.#repaint();
  }

  /**
   * Emit a plain line above the live frame: clear the current frame, print the
   * line, then repaint the frame beneath it.
   */
  passthrough(line: string): string {
    const clear = this.#clearPrevious();
    const frame = this.#renderFrame();
    this.#lastFrame = frame;
    const body = frame.length === 0 ? "" : `${frame.join("\n")}\n`;
    return `${clear}${line}\n${body}`;
  }

  snapshot(): LandoTreePainterSnapshot {
    return {
      frameLines: this.#renderLogicalFrame(),
      activeTaskIds: this.#order.filter((id) => this.#tasks.get(id)?.status === "running"),
    };
  }

  #apply(event: LandoEvent): void {
    const record = event as unknown as Record<string, unknown>;
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
        if (this.#expandedTaskId === id) this.#expandedTaskId = undefined;
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
        if (this.#expandedTaskId === id) this.#expandedTaskId = undefined;
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

  #expandedRunningTask(): TaskState | undefined {
    if (this.#expandedTaskId === undefined) return undefined;
    const task = this.#tasks.get(this.#expandedTaskId);
    return task !== undefined && task.status === "running" ? task : undefined;
  }

  #currentTerminalRows(): number | undefined {
    return this.#getTerminalRows?.() ?? this.#terminalRows;
  }

  #expandedPanelLines(task: TaskState): ReadonlyArray<string> {
    const all = task.fullStream.lines();
    const rows = this.#currentTerminalRows();
    if (rows === undefined) return all;
    const budget = Math.max(1, rows - 1);
    return all.length <= budget ? all : all.slice(all.length - budget);
  }

  #renderExpandedFrame(task: TaskState): ReadonlyArray<string> {
    const lines: string[] = [
      `╭─ LANDO OPS ${statusChip("RUNNING")} expanded task tail`,
      `│ ${statusChip("RUNNING")} · ${task.label}`,
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
    const expanded = this.#expandedRunningTask();
    if (expanded !== undefined)
      return wrapFrameLines(this.#renderExpandedFrame(expanded), this.#currentTerminalColumns());
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
        lines.push(`│ ${statusChip("RUNNING")} · ${task.label}`);
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
    const logical = this.#renderLogicalFrame();
    return logical.map((line) => {
      if (line.startsWith("╭─")) return `${csi.bold}${csi.pink}${line}${csi.reset}`;
      if (line.startsWith("╰─")) return styleBottomFrame(line, csi);
      if (line.includes(statusChip("BLOCKED"))) return styleBodyFrame(line, csi.red, csi.reset, csi);
      if (line.includes(statusChip("CACHED"))) return styleBodyFrame(line, csi.cyan, csi.reset, csi);
      if (line.includes(statusChip("SKIPPED")))
        return styleBodyFrame(line, `${csi.dim}${csi.cyan}`, `${csi.dimReset}${csi.reset}`, csi);
      if (line.includes(statusChip("ONLINE"))) return styleBodyFrame(line, csi.green, csi.reset, csi);
      if (line.includes(statusChip("WAIT"))) return styleBodyFrame(line, csi.amber, csi.reset, csi);
      if (line.includes(statusChip("RUNNING"))) return styleBodyFrame(line, csi.cyan, csi.reset, csi);
      if (line.startsWith("│")) return styleBodyFrame(line, csi.dim, `${csi.dimReset}${csi.reset}`, csi);
      return line;
    });
  }

  #currentTerminalColumns(): number | undefined {
    return this.#getTerminalColumns?.() ?? this.#terminalColumns;
  }

  #clearPrevious(): string {
    const lineCount = physicalRowsForFrame(this.#lastFrame, this.#currentTerminalColumns());
    if (lineCount === 0) return "";
    return `${csi.cursorUp(lineCount)}${csi.carriageReturn}${csi.eraseDown}`;
  }

  #repaint(): string {
    const clear = this.#clearPrevious();
    const frame = this.#renderFrame();
    this.#lastFrame = frame;
    if (frame.length === 0) return clear;
    return `${clear}${frame.join("\n")}\n`;
  }
}
