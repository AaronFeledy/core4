import { Schema } from "effect";

import { type LandoEvent, TaskDetailCollapseEvent, TaskDetailExpandEvent } from "@lando/sdk/events";

import type { TaskTreeViewModel } from "./task-tree-tail.ts";

export type KeyToken = "up" | "down" | "enter" | "esc" | "tab" | "unknown";

const ESC = String.fromCharCode(27);

export const parseKey = (raw: string): KeyToken => {
  switch (raw) {
    case `${ESC}[A`:
      return "up";
    case `${ESC}[B`:
      return "down";
    case "\r":
    case "\n":
      return "enter";
    case ESC:
      return "esc";
    case "\t":
      return "tab";
    default:
      return "unknown";
  }
};

export type KeyAction = "focus.up" | "focus.down" | "tree.cycle" | "detail.expand" | "detail.collapse";

export const DEFAULT_KEYMAP: Readonly<Record<KeyToken, KeyAction | null>> = {
  up: "focus.up",
  down: "focus.down",
  tab: "tree.cycle",
  enter: "detail.expand",
  esc: "detail.collapse",
  unknown: null,
};

export interface KeyHandleResult {
  readonly events: ReadonlyArray<LandoEvent>;
  readonly changed: boolean;
}

export interface TaskTreeInputControllerOptions {
  readonly keymap?: Readonly<Record<KeyToken, KeyAction | null>>;
  readonly now?: () => string;
}

const NO_CHANGE: KeyHandleResult = { events: [], changed: false };

const expandEvent = (taskId: string, timestamp: string): LandoEvent =>
  Schema.decodeUnknownSync(TaskDetailExpandEvent)({ _tag: "task.detail.expand", taskId, timestamp });

const collapseEvent = (taskId: string, timestamp: string): LandoEvent =>
  Schema.decodeUnknownSync(TaskDetailCollapseEvent)({ _tag: "task.detail.collapse", taskId, timestamp });

export class TaskTreeInputController {
  readonly #viewModel: TaskTreeViewModel;
  readonly #keymap: Readonly<Record<KeyToken, KeyAction | null>>;
  readonly #now: () => string;
  #focusIndex = 0;
  #expanded = false;

  constructor(viewModel: TaskTreeViewModel, options: TaskTreeInputControllerOptions = {}) {
    this.#viewModel = viewModel;
    this.#keymap = options.keymap ?? DEFAULT_KEYMAP;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  get focusedTaskId(): string | undefined {
    const ids = this.#viewModel.focusableTaskIds();
    if (ids.length === 0) return undefined;
    return ids[Math.min(this.#focusIndex, ids.length - 1)];
  }

  handleInput(raw: string): KeyHandleResult {
    return this.handleKey(parseKey(raw));
  }

  handleKey(token: KeyToken): KeyHandleResult {
    this.#syncExpandedState();
    switch (this.#keymap[token]) {
      case "focus.up":
        return this.#moveFocus(-1);
      case "focus.down":
        return this.#moveFocus(1);
      case "detail.expand":
        return this.#expand();
      case "detail.collapse":
        return this.#collapse();
      default:
        return NO_CHANGE;
    }
  }

  #syncExpandedState(): void {
    if (this.#expanded && this.#viewModel.expandedTaskId === undefined) this.#expanded = false;
  }

  #moveFocus(delta: number): KeyHandleResult {
    const count = this.#viewModel.focusableTaskIds().length;
    if (count === 0) return NO_CHANGE;
    const next = Math.max(0, Math.min(count - 1, this.#focusIndex + delta));
    if (next === this.#focusIndex) return NO_CHANGE;
    this.#focusIndex = next;
    return { events: [], changed: true };
  }

  #expand(): KeyHandleResult {
    if (this.#expanded) return NO_CHANGE;
    const taskId = this.focusedTaskId;
    if (taskId === undefined || !this.#viewModel.canExpandTask(taskId)) return NO_CHANGE;
    this.#viewModel.expandTask(taskId);
    this.#expanded = true;
    return { events: [expandEvent(taskId, this.#now())], changed: true };
  }

  #collapse(): KeyHandleResult {
    if (!this.#expanded) return NO_CHANGE;
    const taskId = this.#viewModel.expandedTaskId ?? this.focusedTaskId;
    this.#viewModel.collapse();
    this.#expanded = false;
    if (taskId === undefined) return { events: [], changed: true };
    return { events: [collapseEvent(taskId, this.#now())], changed: true };
  }
}
