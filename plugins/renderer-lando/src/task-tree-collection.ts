import type { AbsolutePath } from "@lando/sdk/schema";
import type { LandoEvent } from "@lando/sdk/services";

import { aggregateRenderState } from "./task-tree-aggregate.ts";
import { TaskTreeAnimationController } from "./task-tree-animation.ts";
import { occurrenceTaskId, parseOccurrenceTaskId, rawEventTaskId } from "./task-tree-occurrence.ts";
import { renderLogicalFrame, renderTreeFrame, styleFrame } from "./task-tree-render.ts";
import {
  type TaskTreeInteractionModel,
  TaskTreeViewModel,
  type TaskTreeViewModelOptions,
} from "./task-tree-tail.ts";

interface TaskTreeCollectionOutput {
  readonly render: () => void;
  readonly requestLive: () => void;
  readonly dropLive: () => void;
}

interface TaskTreeEntry {
  readonly viewModel: TaskTreeViewModel;
  readonly animation: TaskTreeAnimationController;
}

const stringField = (event: LandoEvent, key: string): string | undefined => {
  const value = Reflect.get(event, key);
  return typeof value === "string" ? value : undefined;
};

const childrenOf = (event: LandoEvent): ReadonlyArray<string> => {
  const children = Reflect.get(event, "children");
  return Array.isArray(children)
    ? children.filter((child): child is string => typeof child === "string")
    : [];
};

export interface TaskTreeConsumeResult {
  readonly completedLines: ReadonlyArray<string>;
}

export class TaskTreeCollection implements TaskTreeInteractionModel {
  readonly #entries = new Map<string, TaskTreeEntry>();
  readonly #taskOwners = new Map<string, string>();
  readonly #fallback: TaskTreeViewModel;
  readonly #viewModelOptions: TaskTreeViewModelOptions;
  readonly #output: TaskTreeCollectionOutput;
  #selectedParentId: string | undefined;
  #footerVisible = false;
  #sessionCommandId: string | undefined;

  constructor(options: TaskTreeViewModelOptions, output: TaskTreeCollectionOutput) {
    this.#viewModelOptions = options;
    this.#fallback = new TaskTreeViewModel(options);
    this.#output = output;
  }

  openSession(commandId: string): void {
    this.#sessionCommandId = commandId;
    this.#footerVisible = true;
    for (const entry of this.#entries.values()) entry.animation.setVisible(true);
  }

  closeSession(): ReadonlyArray<string> {
    const lines =
      this.#sessionCommandId === undefined
        ? this.#selectedModel().treeFrameLines()
        : styleFrame(renderTreeFrame(this.#aggregateState()));
    this.#sessionCommandId = undefined;
    this.#footerVisible = false;
    return lines;
  }

  hasTasks(): boolean {
    return this.#entries.size > 0;
  }

  consume(event: LandoEvent): TaskTreeConsumeResult {
    if (event._tag === "task.tree.start") {
      const parentId = stringField(event, "parentId");
      if (parentId === undefined) return { completedLines: [] };
      const entry = this.#startTree(parentId);
      for (const taskId of childrenOf(event)) this.#taskOwners.set(taskId, parentId);
      entry.viewModel.apply(event);
      entry.animation.consume(event);
      this.#select(parentId);
      this.#footerVisible = true;
      return { completedLines: [] };
    }

    const entry = this.#entryFor(event);
    if (entry === undefined) return { completedLines: [] };
    const taskId = stringField(event, "taskId");
    if (event._tag === "task.start" && taskId !== undefined) {
      this.#taskOwners.set(taskId, this.#parentIdFor(entry));
    }
    entry.viewModel.apply(event);
    entry.animation.consume(event);
    if (event._tag !== "task.tree.complete") {
      if (entry === this.#selectedEntry() || this.#sessionCommandId !== undefined) this.#footerVisible = true;
      return { completedLines: [] };
    }
    if (this.#sessionCommandId !== undefined) {
      this.#footerVisible = true;
      return { completedLines: [] };
    }
    if (entry === this.#selectedEntry() && entry.viewModel.expandedTaskId === undefined) {
      this.#footerVisible = this.#entries.size > 1;
    }
    return { completedLines: entry.viewModel.treeFrameLines() };
  }

  frameLines(): ReadonlyArray<string> {
    if (!this.#footerVisible) return [];
    if (this.#sessionCommandId !== undefined) return styleFrame(renderLogicalFrame(this.#aggregateState()));
    return this.#selectedModel().frameLines();
  }

  get expandedTaskId(): string | undefined {
    if (this.#sessionCommandId === undefined) return this.#selectedModel().expandedTaskId;
    for (const [parentId, entry] of this.#entries) {
      const raw = entry.viewModel.expandedTaskId;
      if (raw !== undefined) return occurrenceTaskId(parentId, raw);
    }
    return undefined;
  }

  eventTaskId(internalId: string): string {
    return rawEventTaskId(internalId);
  }

  focusableTaskIds(): ReadonlyArray<string> {
    if (this.#sessionCommandId === undefined) return this.#selectedModel().focusableTaskIds();
    return [...this.#entries].flatMap(([parentId, entry]) =>
      entry.viewModel.focusableTaskIds().map((taskId) => occurrenceTaskId(parentId, taskId)),
    );
  }

  transcriptPathFor(taskId: string): AbsolutePath | undefined {
    const resolved = this.#resolveTask(taskId);
    return resolved.model.transcriptPathFor(resolved.rawTaskId);
  }

  canExpandTask(taskId: string): boolean {
    const resolved = this.#resolveTask(taskId);
    return resolved.model.canExpandTask(resolved.rawTaskId);
  }

  expandTask(taskId: string): void {
    const resolved = this.#resolveTask(taskId);
    for (const entry of this.#entries.values()) {
      if (entry.viewModel !== resolved.model) entry.viewModel.collapse();
    }
    if (this.#fallback !== resolved.model) this.#fallback.collapse();
    if (resolved.parentId !== undefined) this.#select(resolved.parentId);
    const model = resolved.model;
    model.expandTask(resolved.rawTaskId);
    if (model.expandedTaskId === resolved.rawTaskId) this.#footerVisible = true;
  }

  setExpandedTranscript(taskId: string, lines: ReadonlyArray<string>): boolean {
    const resolved = this.#resolveTask(taskId);
    return resolved.model.setExpandedTranscript(resolved.rawTaskId, lines);
  }

  expandedLineBudget(): number {
    return this.#selectedModel().expandedLineBudget();
  }

  collapse(): void {
    for (const entry of this.#entries.values()) entry.viewModel.collapse();
    this.#fallback.collapse();
    if (this.#selectedEntry() !== undefined || this.#sessionCommandId !== undefined)
      this.#footerVisible = true;
  }

  cycleTree(): boolean {
    if (this.#entries.size < 2) return false;
    const parentIds = [...this.#entries.keys()];
    const currentIndex =
      this.#selectedParentId === undefined ? -1 : parentIds.indexOf(this.#selectedParentId);
    const nextParentId = parentIds[(currentIndex + 1) % parentIds.length];
    if (nextParentId === undefined) return false;
    this.#select(nextParentId);
    this.#footerVisible = true;
    return true;
  }

  dispose(): void {
    for (const entry of this.#entries.values()) entry.animation.dispose();
  }

  #aggregateState() {
    return aggregateRenderState(
      this.#sessionCommandId ?? "tasks",
      [...this.#entries].map(([parentId, entry]) => ({
        parentId,
        state: entry.viewModel.renderState(),
      })),
    );
  }

  #startTree(parentId: string): TaskTreeEntry {
    const previous = this.#entries.get(parentId);
    if (previous !== undefined) {
      previous.animation.dispose();
      for (const [taskId, owner] of this.#taskOwners) {
        if (owner === parentId) this.#taskOwners.delete(taskId);
      }
    }
    const viewModel = new TaskTreeViewModel(this.#viewModelOptions);
    const animation = new TaskTreeAnimationController(viewModel, this.#output);
    const entry = { viewModel, animation } satisfies TaskTreeEntry;
    this.#entries.set(parentId, entry);
    if (this.#sessionCommandId !== undefined) animation.setVisible(true);
    return entry;
  }

  #entryFor(event: LandoEvent): TaskTreeEntry | undefined {
    switch (event._tag) {
      case "task.tree.complete":
        return this.#entries.get(stringField(event, "parentId") ?? "");
      case "task.start": {
        const taskId = stringField(event, "taskId");
        const parentId = stringField(event, "parentId");
        if (parentId !== undefined) return this.#entries.get(parentId);
        const inferredParentId = taskId === undefined ? "" : (this.#taskOwners.get(taskId) ?? "");
        return this.#entries.get(inferredParentId) ?? this.#selectedEntry();
      }
      case "task.detail":
      case "task.complete":
      case "task.fail": {
        const taskId = stringField(event, "taskId");
        return this.#entries.get(taskId === undefined ? "" : (this.#taskOwners.get(taskId) ?? ""));
      }
      default:
        return undefined;
    }
  }

  #select(parentId: string): void {
    if (parentId === this.#selectedParentId) return;
    if (this.#sessionCommandId === undefined) this.#selectedEntry()?.animation.setVisible(false);
    this.#selectedParentId = parentId;
    this.#selectedEntry()?.animation.setVisible(true);
  }

  #selectedEntry(): TaskTreeEntry | undefined {
    return this.#selectedParentId === undefined ? undefined : this.#entries.get(this.#selectedParentId);
  }

  #selectedModel(): TaskTreeViewModel {
    return this.#selectedEntry()?.viewModel ?? this.#fallback;
  }

  #resolveTask(taskId: string): {
    readonly parentId: string | undefined;
    readonly rawTaskId: string;
    readonly model: TaskTreeViewModel;
  } {
    const parsed = parseOccurrenceTaskId(taskId);
    if (parsed !== undefined) {
      return {
        parentId: parsed.parentId,
        rawTaskId: parsed.rawTaskId,
        model: this.#entries.get(parsed.parentId)?.viewModel ?? this.#fallback,
      };
    }
    const owner = this.#taskOwners.get(taskId);
    return {
      parentId: owner,
      rawTaskId: taskId,
      model:
        owner === undefined ? this.#selectedModel() : (this.#entries.get(owner)?.viewModel ?? this.#fallback),
    };
  }

  #parentIdFor(target: TaskTreeEntry): string {
    for (const [parentId, entry] of this.#entries) {
      if (entry === target) return parentId;
    }
    return "";
  }
}
