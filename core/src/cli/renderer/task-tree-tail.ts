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

const ansiPattern = new RegExp(`${ESC}\\[[0-9;]*[A-Za-z]`, "g");

const visibleLength = (line: string): number => line.replace(ansiPattern, "").length;

const DEFAULT_TERMINAL_COLUMNS = 80;

type VisualStatus = "WAIT" | "RUNNING" | "ONLINE" | "BLOCKED";

const statusChip = (status: VisualStatus): string => `[${status}]`;

const normalizeTerminalColumns = (terminalColumns: number | undefined): number =>
  terminalColumns === undefined ? DEFAULT_TERMINAL_COLUMNS : Math.max(1, Math.trunc(terminalColumns));

const splitContentToWidth = (content: string, width: number): ReadonlyArray<string> => {
  if (visibleLength(content) <= width) return [content];
  const words = content.split(/(\s+)/).filter((part) => part.length > 0);
  const lines: string[] = [];
  let current = "";
  const budget = Math.max(1, width);

  const pushCurrent = (): void => {
    if (current.length === 0) return;
    lines.push(current.trimEnd());
    current = "";
  };

  for (const word of words) {
    if (visibleLength(current) + visibleLength(word) <= budget) {
      current += word;
      continue;
    }
    if (current.trim().length > 0) pushCurrent();
    let remaining = word.trimStart();
    while (visibleLength(current) + visibleLength(remaining) > budget) {
      const available = Math.max(1, budget - visibleLength(current));
      current += remaining.slice(0, available);
      remaining = remaining.slice(available);
      pushCurrent();
    }
    current += remaining;
  }

  if (current.trim().length > 0) lines.push(current.trimEnd());
  return lines.length === 0 ? [content.slice(0, width)] : lines;
};

const capLine = (left: string, text: string, right: string, width: number): string => {
  const maxTextWidth = Math.max(1, width - visibleLength(left) - visibleLength(right) - 2);
  const fittedText =
    visibleLength(text) <= maxTextWidth ? text : `${text.slice(0, Math.max(1, maxTextWidth - 1))}…`;
  const prefix = `${left} ${fittedText} `;
  const fill = Math.max(0, width - visibleLength(prefix) - visibleLength(right));
  return `${prefix}${"─".repeat(fill)}${right}`;
};

const bodyLine = (text: string, width: number): string => {
  const bodyWidth = Math.max(1, width - 4);
  const padding = Math.max(0, bodyWidth - visibleLength(text));
  return `│ ${text}${" ".repeat(padding)} │`;
};

const wrapFrameLines = (
  lines: ReadonlyArray<string>,
  terminalColumns: number | undefined,
): ReadonlyArray<string> => {
  const columns = normalizeTerminalColumns(terminalColumns);
  if (columns < 60) return lines;
  return lines.flatMap((line) => {
    if (line.startsWith("╭─")) return [capLine("╭─", line.slice(2).trim(), "╮", columns)];
    if (line.startsWith("╰─")) return [capLine("╰─", line.slice(2).trim(), "╯", columns)];
    if (line.startsWith("│")) {
      const hangingIndent = line.startsWith("│    ") ? "  " : "";
      const content = line.slice(1).trimStart();
      const contentWidth = Math.max(1, columns - 4 - visibleLength(hangingIndent));
      return splitContentToWidth(content, contentWidth).map((segment) =>
        bodyLine(`${hangingIndent}${segment}`, columns),
      );
    }
    return splitContentToWidth(line, columns).map((segment) => bodyLine(segment, columns));
  });
};

const physicalRowsForLine = (line: string, terminalColumns: number | undefined): number => {
  const columns = normalizeTerminalColumns(terminalColumns);
  return line
    .split("\n")
    .reduce((rows, segment) => rows + Math.max(1, Math.ceil(visibleLength(segment) / columns)), 0);
};

const physicalRowsForFrame = (frame: ReadonlyArray<string>, terminalColumns: number | undefined): number =>
  frame.reduce((rows, line) => rows + physicalRowsForLine(line, terminalColumns), 0);

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
    const label = task.summary ?? task.label;
    if (task.status === "done") {
      return `│ ${statusChip("ONLINE")} ✓ ${label}${formatDurationSuffix(task.durationMs)}`;
    }
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
      if (line.startsWith("╭─")) return `${csi.bold}${csi.cyan}${line}${csi.reset}`;
      if (line.startsWith("╰─")) return `${csi.dim}${csi.cyan}${line}${csi.dimReset}${csi.reset}`;
      if (line.includes(statusChip("BLOCKED"))) return `${csi.red}${line}${csi.reset}`;
      if (line.includes(statusChip("ONLINE"))) return `${csi.green}${line}${csi.reset}`;
      if (line.includes(statusChip("WAIT"))) return `${csi.amber}${line}${csi.reset}`;
      if (line.includes(statusChip("RUNNING"))) return `${csi.cyan}${line}${csi.reset}`;
      if (line.startsWith("│")) return `${csi.dim}${line}${csi.dimReset}${csi.reset}`;
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
