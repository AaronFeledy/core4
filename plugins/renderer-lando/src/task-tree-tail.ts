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

/** Fixed ring-buffer depth for the task-detail tail panel. */
export const TASK_DETAIL_TAIL_CAPACITY = 4 as const;

/** Retained depth of the expandable full-stream tail (bounded by terminal scroll on render). */
export const TASK_DETAIL_EXPANDED_CAPACITY = 1000 as const;

const ESC = String.fromCharCode(27);

/**
 * SGR styling sequences used by the task-tree view-model's styled frame mapping.
 * Co-located here because the repo intentionally ships no ANSI dependency. The
 * view-model emits only color/style SGR codes — never cursor-movement or erase
 * sequences; those belong to the substrate live region, not the view-model.
 */
export const csi = {
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

const ansiPattern = new RegExp(`${ESC}\\[[0-9;]*[A-Za-z]`, "g");

const visibleLength = (line: string): number => line.replace(ansiPattern, "").length;

const DEFAULT_TERMINAL_COLUMNS = 80;

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

const styleBodyFrame = (line: string, styleStart: string, styleEnd: string): string => {
  const hasTrailingFrame = line.endsWith("│");
  const content = line.slice(1, hasTrailingFrame ? -1 : undefined);
  const trailingFrame = hasTrailingFrame ? `${csi.pink}│${csi.reset}` : "";
  return `${csi.pink}${line.slice(0, 1)}${csi.reset}${styleStart}${content}${styleEnd}${trailingFrame}`;
};

const styleBottomFrame = (line: string): string => {
  let trailingFrameStart = line.length;
  if (line.endsWith("╯")) {
    trailingFrameStart -= 1;
    while (trailingFrameStart > 2 && line[trailingFrameStart - 1] === "─") trailingFrameStart -= 1;
  }
  const content = line.slice(2, trailingFrameStart);
  const trailingFrame = line.slice(trailingFrameStart);
  const styledTrailingFrame = trailingFrame.length === 0 ? "" : `${csi.pink}${trailingFrame}${csi.reset}`;
  return `${csi.pink}${line.slice(0, 2)}${csi.reset}${csi.dim}${csi.pink}${content}${csi.dimReset}${csi.reset}${styledTrailingFrame}`;
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
  #tree: TreeState | undefined;
  #expandedTaskId: string | undefined;

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

  /** True while a running task is on screen; the runtime live-gates continuous rendering on this. */
  hasAnimatedAffordance(): boolean {
    return this.#runningCount() > 0;
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

  /** Focus/expand the given running task's full-stream tail (state only). */
  expandTask(taskId: string): void {
    if (!this.canExpandTask(taskId)) return;
    this.#expandedTaskId = taskId;
  }

  /** Collapse any expanded task back to the concurrent tree view (state only). */
  collapse(): void {
    this.#expandedTaskId = undefined;
  }

  snapshot(): TaskTreeViewModelSnapshot {
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
