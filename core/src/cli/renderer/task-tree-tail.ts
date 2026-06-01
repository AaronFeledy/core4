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
 * `runtime.ts`; interactive input/expand-collapse and the byte-for-byte
 * first-paint contract can be built on top of this seam without changing
 * the painter core.
 */

import type { LandoEvent } from "@lando/sdk/services";

/** Fixed ring-buffer depth for the task-detail tail panel. */
export const TASK_DETAIL_TAIL_CAPACITY = 4 as const;

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

type TaskStatus = "running" | "done" | "failed";

interface TaskState {
  readonly id: string;
  label: string;
  status: TaskStatus;
  summary: string | undefined;
  durationMs: number | undefined;
  exitCode: number | undefined;
  remediation: string | undefined;
  readonly ring: TaskDetailRing;
}

interface TreeState {
  readonly parentId: string;
  label: string;
  done: boolean;
  summary: string | undefined;
  succeeded: number;
  failed: number;
}

const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const asNumber = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);

const formatDurationSuffix = (durationMs: number | undefined): string => {
  if (durationMs === undefined) return "";
  if (durationMs < 1000) return ` (${durationMs}ms)`;
  return ` (${(durationMs / 1000).toFixed(1)}s)`;
};

export interface LandoTreePainterOptions {
  /** Ring-buffer depth (defaults to {@link TASK_DETAIL_TAIL_CAPACITY}). */
  readonly detailCapacity?: number;
}

export interface LandoTreePainterSnapshot {
  /** Logical frame lines with no control bytes (for structural assertions). */
  readonly frameLines: ReadonlyArray<string>;
  /** Ids of tasks still running (panel still rendered). */
  readonly activeTaskIds: ReadonlyArray<string>;
}

const CHILD_INDENT = "  ";
const PANEL_INDENT = "      ";

/**
 * Pure, deterministic painter for the concurrent task-tree tail. Drive it with
 * the renderable `task.*` events; non-tree output is routed through
 * {@link LandoTreePainter.passthrough} so it scrolls above the live frame
 * without corrupting the cursor.
 */
export class LandoTreePainter {
  readonly #detailCapacity: number;
  readonly #tasks = new Map<string, TaskState>();
  readonly #order: string[] = [];
  #tree: TreeState | undefined;
  #lastFrameLineCount = 0;

  constructor(options: LandoTreePainterOptions = {}) {
    this.#detailCapacity = options.detailCapacity ?? TASK_DETAIL_TAIL_CAPACITY;
  }

  consume(event: LandoEvent): string {
    this.#apply(event);
    return this.#repaint();
  }

  /**
   * Emit a plain line above the live frame: clear the current frame, print the
   * line, then repaint the frame beneath it.
   */
  passthrough(line: string): string {
    const clear = this.#clearPrevious();
    const frame = this.#renderFrame();
    this.#lastFrameLineCount = frame.length;
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
        this.#tree = {
          parentId: asString(record.parentId) ?? "tree",
          label: asString(record.label) ?? "tasks",
          done: false,
          summary: undefined,
          succeeded: 0,
          failed: 0,
        };
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
        task.ring.push(stream === "stderr" ? `! ${line}` : line);
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
        return;
      }
      case "task.tree.complete": {
        if (this.#tree === undefined) {
          this.#tree = {
            parentId: asString(record.parentId) ?? "tree",
            label: asString(record.summary) ?? "tasks",
            done: true,
            summary: asString(record.summary),
            succeeded: asNumber(record.succeeded) ?? 0,
            failed: asNumber(record.failed) ?? 0,
          };
          return;
        }
        this.#tree.done = true;
        this.#tree.summary = asString(record.summary);
        this.#tree.succeeded = asNumber(record.succeeded) ?? 0;
        this.#tree.failed = asNumber(record.failed) ?? 0;
        this.#tree.label = asString(record.summary) ?? this.#tree.label;
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
      return `▶ ${label} (${tree.succeeded} ✓ · ${tree.failed} ✗)`;
    }
    return `▼ ${tree.label} (${this.#runningCount()}/${this.#order.length} running)`;
  }

  #childSummaryLine(task: TaskState): string {
    const label = task.summary ?? task.label;
    if (task.status === "done") {
      return `${CHILD_INDENT}✓ ${label}${formatDurationSuffix(task.durationMs)}`;
    }
    const exitSuffix = task.exitCode === undefined ? "" : ` (exit ${task.exitCode})`;
    return `${CHILD_INDENT}✗ ${label}${exitSuffix}${formatDurationSuffix(task.durationMs)}`;
  }

  // Logical frame: human content, no control bytes.
  #renderLogicalFrame(): ReadonlyArray<string> {
    const lines: string[] = [];
    const parent = this.#parentLine();
    if (parent !== undefined) lines.push(parent);
    for (const id of this.#order) {
      const task = this.#tasks.get(id);
      if (task === undefined) continue;
      if (task.status === "running") {
        lines.push(`${CHILD_INDENT}· ${task.label}`);
        for (const detail of task.ring.lines()) {
          lines.push(`${PANEL_INDENT}${detail}`);
        }
        continue;
      }
      lines.push(this.#childSummaryLine(task));
      if (task.status === "failed" && task.remediation !== undefined) {
        lines.push(`${PANEL_INDENT}↳ ${task.remediation}`);
      }
    }
    return lines;
  }

  // Styled frame: dims the indented detail panel rows.
  #renderFrame(): ReadonlyArray<string> {
    const logical = this.#renderLogicalFrame();
    return logical.map((line) => (line.startsWith(PANEL_INDENT) ? `${csi.dim}${line}${csi.dimReset}` : line));
  }

  #clearPrevious(): string {
    if (this.#lastFrameLineCount === 0) return "";
    return `${csi.cursorUp(this.#lastFrameLineCount)}${csi.carriageReturn}${csi.eraseDown}`;
  }

  #repaint(): string {
    const clear = this.#clearPrevious();
    const frame = this.#renderFrame();
    this.#lastFrameLineCount = frame.length;
    if (frame.length === 0) return clear;
    return `${clear}${frame.join("\n")}\n`;
  }
}
