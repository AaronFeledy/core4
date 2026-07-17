import type { AbsolutePath } from "@lando/sdk/schema";
import type { LandoEvent } from "@lando/sdk/services";

import { TaskTreeAnimationController } from "./task-tree-animation.ts";
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

  constructor(options: TaskTreeViewModelOptions, output: TaskTreeCollectionOutput) {
    this.#viewModelOptions = options;
    this.#fallback = new TaskTreeViewModel(options);
    this.#output = output;
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
      if (entry === this.#selectedEntry()) this.#footerVisible = true;
      return { completedLines: [] };
    }

    if (entry === this.#selectedEntry() && entry.viewModel.expandedTaskId === undefined) {
      this.#footerVisible = this.#entries.size > 1;
    }
    return { completedLines: entry.viewModel.treeFrameLines() };
  }

  frameLines(): ReadonlyArray<string> {
    return this.#footerVisible ? this.#selectedModel().frameLines() : [];
  }

  get expandedTaskId(): string | undefined {
    return this.#selectedModel().expandedTaskId;
  }

  focusableTaskIds(): ReadonlyArray<string> {
    return this.#selectedModel().focusableTaskIds();
  }

  transcriptPathFor(taskId: string): AbsolutePath | undefined {
    return this.#selectedModel().transcriptPathFor(taskId);
  }

  canExpandTask(taskId: string): boolean {
    return this.#selectedModel().canExpandTask(taskId);
  }

  expandTask(taskId: string): void {
    this.#selectedModel().expandTask(taskId);
    if (this.#selectedModel().expandedTaskId === taskId) this.#footerVisible = true;
  }

  setExpandedTranscript(taskId: string, lines: ReadonlyArray<string>): boolean {
    return this.#selectedModel().setExpandedTranscript(taskId, lines);
  }

  expandedLineBudget(): number {
    return this.#selectedModel().expandedLineBudget();
  }

  collapse(): void {
    this.#selectedModel().collapse();
    if (this.#selectedEntry() !== undefined) this.#footerVisible = true;
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
    return entry;
  }

  #entryFor(event: LandoEvent): TaskTreeEntry | undefined {
    switch (event._tag) {
      case "task.tree.complete":
        return this.#entries.get(stringField(event, "parentId") ?? "");
      case "task.start": {
        const taskId = stringField(event, "taskId");
        const parentId = stringField(event, "parentId");
        return parentId === undefined
          ? (this.#entries.get(taskId === undefined ? "" : (this.#taskOwners.get(taskId) ?? "")) ??
              this.#selectedEntry())
          : this.#entries.get(parentId);
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
    this.#selectedEntry()?.animation.setVisible(false);
    this.#selectedParentId = parentId;
    this.#selectedEntry()?.animation.setVisible(true);
  }

  #selectedEntry(): TaskTreeEntry | undefined {
    return this.#selectedParentId === undefined ? undefined : this.#entries.get(this.#selectedParentId);
  }

  #selectedModel(): TaskTreeViewModel {
    return this.#selectedEntry()?.viewModel ?? this.#fallback;
  }

  #parentIdFor(target: TaskTreeEntry): string {
    for (const [parentId, entry] of this.#entries) {
      if (entry === target) return parentId;
    }
    return "";
  }
}
