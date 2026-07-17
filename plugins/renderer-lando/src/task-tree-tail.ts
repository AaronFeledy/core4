import { Schema } from "effect";

import { AbsolutePath } from "@lando/sdk/schema";
import type { LandoEvent } from "@lando/sdk/services";

import { TASK_DETAIL_TAIL_CAPACITY, TaskDetailRing } from "./task-detail-ring.ts";
import { csi } from "./task-tree-frame.ts";
import {
  SPINNER_FRAMES,
  type TaskState,
  type TaskTreeRenderState,
  type TreeState,
  renderLogicalFrame,
  renderTreeFrame,
  styleFrame,
} from "./task-tree-render.ts";

export { csi, TASK_DETAIL_TAIL_CAPACITY, TaskDetailRing };

const DEFAULT_EXPANDED_LINE_LIMIT = 1000;
const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const asNumber = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);
const asAbsolutePath = (value: unknown): typeof AbsolutePath.Type | undefined =>
  Schema.is(AbsolutePath)(value) ? value : undefined;

export interface TaskTreeViewModelOptions {
  readonly detailCapacity?: number;
  readonly terminalColumns?: number | undefined;
  readonly getTerminalColumns?: (() => number | undefined) | undefined;
  readonly terminalRows?: number | undefined;
  readonly getTerminalRows?: (() => number | undefined) | undefined;
}

export interface TaskTreeViewModelSnapshot {
  readonly frameLines: ReadonlyArray<string>;
  readonly activeTaskIds: ReadonlyArray<string>;
}

export interface TaskTreeInteractionModel {
  readonly expandedTaskId: string | undefined;
  focusableTaskIds(): ReadonlyArray<string>;
  transcriptPathFor(taskId: string): AbsolutePath | undefined;
  canExpandTask(taskId: string): boolean;
  expandTask(taskId: string): void;
  setExpandedTranscript(taskId: string, lines: ReadonlyArray<string>): boolean;
  expandedLineBudget(): number;
  collapse(): void;
  cycleTree(): boolean;
}

type NewTaskInput = {
  readonly id: string;
  readonly label: string;
  readonly status: TaskState["status"];
  readonly transcriptPath: typeof AbsolutePath.Type | undefined;
};

export class TaskTreeViewModel implements TaskTreeInteractionModel {
  readonly #detailCapacity: number;
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
  #expandedLines: ReadonlyArray<string> = [];

  constructor(options: TaskTreeViewModelOptions = {}) {
    this.#detailCapacity = options.detailCapacity ?? TASK_DETAIL_TAIL_CAPACITY;
    this.#terminalColumns = options.terminalColumns;
    this.#getTerminalColumns = options.getTerminalColumns;
    this.#terminalRows = options.terminalRows;
    this.#getTerminalRows = options.getTerminalRows;
  }

  apply(event: LandoEvent): void {
    switch (event._tag) {
      case "task.tree.start": {
        this.#resetTreeState();
        const uniqueChildren = Array.isArray(event.children)
          ? [...new Set(event.children.filter((child): child is string => typeof child === "string"))]
          : [];
        this.#tree = {
          parentId: asString(event.parentId) ?? "tree",
          childCount: uniqueChildren.length,
          label: asString(event.label) ?? "tasks",
          done: false,
          summary: undefined,
          succeeded: 0,
          failed: 0,
          durationMs: undefined,
        };
        for (const childId of uniqueChildren) {
          this.#order.push(childId);
          this.#tasks.set(
            childId,
            this.#newTask({ id: childId, label: childId, status: "pending", transcriptPath: undefined }),
          );
        }
        return;
      }
      case "task.start": {
        const taskId = asString(event.taskId);
        if (taskId === undefined) return;
        if (!this.#tasks.has(taskId)) this.#order.push(taskId);
        this.#tasks.set(
          taskId,
          this.#newTask({
            id: taskId,
            label: asString(event.label) ?? taskId,
            status: "running",
            transcriptPath: asAbsolutePath(event.transcriptPath),
          }),
        );
        return;
      }
      case "task.detail": {
        const taskId = asString(event.taskId);
        if (taskId === undefined) return;
        const task = this.#tasks.get(taskId);
        if (task === undefined || task.status !== "running") return;
        const line = asString(event.line) ?? "";
        task.ring.push(asString(event.stream) === "stderr" ? `! ${line}` : line);
        return;
      }
      case "task.complete": {
        const taskId = asString(event.taskId);
        if (taskId === undefined) return;
        const task = this.#tasks.get(taskId);
        if (task === undefined) return;
        task.status = "done";
        task.summary = asString(event.summary);
        task.durationMs = asNumber(event.durationMs);
        this.#spinningTaskIds.delete(taskId);
        return;
      }
      case "task.fail": {
        const taskId = asString(event.taskId);
        if (taskId === undefined) return;
        const task = this.#tasks.get(taskId);
        if (task === undefined) return;
        task.status = "failed";
        task.summary = asString(event.summary);
        task.durationMs = asNumber(event.durationMs);
        task.exitCode = asNumber(event.exitCode);
        task.remediation = asString(event.remediation);
        this.#spinningTaskIds.delete(taskId);
        return;
      }
      case "task.tree.complete": {
        if (this.#tree === undefined) {
          this.#tree = {
            parentId: asString(event.parentId) ?? "tree",
            childCount: 0,
            label: asString(event.summary) ?? "tasks",
            done: true,
            summary: asString(event.summary),
            succeeded: asNumber(event.succeeded) ?? 0,
            failed: asNumber(event.failed) ?? 0,
            durationMs: asNumber(event.durationMs),
          };
          return;
        }
        this.#tree.done = true;
        this.#tree.summary = asString(event.summary);
        this.#tree.succeeded = asNumber(event.succeeded) ?? 0;
        this.#tree.failed = asNumber(event.failed) ?? 0;
        this.#tree.label = asString(event.summary) ?? this.#tree.label;
        this.#tree.durationMs = asNumber(event.durationMs);
        return;
      }
      default:
        return;
    }
  }

  frameLines(): ReadonlyArray<string> {
    return styleFrame(renderLogicalFrame(this.#renderState()));
  }

  treeFrameLines(): ReadonlyArray<string> {
    return styleFrame(renderTreeFrame(this.#renderState()));
  }

  snapshot(): TaskTreeViewModelSnapshot {
    return {
      frameLines: renderLogicalFrame(this.#renderState()),
      activeTaskIds: this.#order.filter((id) => this.#tasks.get(id)?.status === "running"),
    };
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

  transcriptPathFor(taskId: string): AbsolutePath | undefined {
    return this.#tasks.get(taskId)?.transcriptPath;
  }

  canExpandTask(taskId: string): boolean {
    const task = this.#tasks.get(taskId);
    return task !== undefined && task.status !== "pending" && task.transcriptPath !== undefined;
  }

  isRunningTask(taskId: string): boolean {
    return this.#tasks.get(taskId)?.status === "running";
  }

  expandTask(taskId: string): void {
    if (!this.canExpandTask(taskId)) return;
    this.#expandedTaskId = taskId;
    this.#expandedLines = [];
  }

  setExpandedTranscript(taskId: string, lines: ReadonlyArray<string>): boolean {
    if (this.#expandedTaskId !== taskId) return false;
    this.#expandedLines = [...lines];
    return true;
  }

  expandedLineBudget(): number {
    const rows = this.#getTerminalRows?.() ?? this.#terminalRows;
    return rows === undefined ? DEFAULT_EXPANDED_LINE_LIMIT : Math.max(0, rows - 3);
  }

  collapse(): void {
    this.#expandedTaskId = undefined;
    this.#expandedLines = [];
  }

  cycleTree(): boolean {
    return false;
  }

  #resetTreeState(): void {
    this.#tasks.clear();
    this.#order.length = 0;
    this.#spinningTaskIds.clear();
    this.#tree = undefined;
    this.#expandedTaskId = undefined;
    this.#expandedLines = [];
  }

  #newTask(input: NewTaskInput): TaskState {
    return {
      id: input.id,
      label: input.label,
      status: input.status,
      transcriptPath: input.transcriptPath,
      summary: undefined,
      durationMs: undefined,
      exitCode: undefined,
      remediation: undefined,
      ring: new TaskDetailRing(this.#detailCapacity),
    };
  }

  #renderState(): TaskTreeRenderState {
    return {
      tree: this.#tree,
      tasks: this.#tasks,
      order: this.#order,
      spinningTaskIds: this.#spinningTaskIds,
      spinnerFrame: this.#spinnerFrame,
      expandedTaskId: this.#expandedTaskId,
      expandedLines: this.#expandedLines,
      terminalColumns: this.#getTerminalColumns?.() ?? this.#terminalColumns,
    };
  }
}
