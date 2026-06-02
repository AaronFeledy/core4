import { Schema } from "effect";

import { type LandoEvent, TaskDetailCollapseEvent, TaskDetailExpandEvent } from "@lando/sdk/events";

import type { LandoTreePainter } from "./task-tree-tail.ts";

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

const makeKeybindingEvent = (
  schema: typeof TaskDetailExpandEvent | typeof TaskDetailCollapseEvent,
  tag: "task.detail.expand" | "task.detail.collapse",
  taskId: string,
  timestamp: string,
): LandoEvent => Schema.decodeUnknownSync(schema)({ _tag: tag, taskId, timestamp }) as LandoEvent;

export class TaskTreeInputController {
  readonly #painter: LandoTreePainter;
  readonly #keymap: Readonly<Record<KeyToken, KeyAction | null>>;
  readonly #now: () => string;
  #focusIndex = 0;
  #expanded = false;

  constructor(painter: LandoTreePainter, options: TaskTreeInputControllerOptions = {}) {
    this.#painter = painter;
    this.#keymap = options.keymap ?? DEFAULT_KEYMAP;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  get focusedTaskId(): string | undefined {
    const ids = this.#painter.focusableTaskIds();
    if (ids.length === 0) return undefined;
    return ids[Math.min(this.#focusIndex, ids.length - 1)];
  }

  handleInput(raw: string): KeyHandleResult {
    return this.handleKey(parseKey(raw));
  }

  handleKey(token: KeyToken): KeyHandleResult {
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

  #moveFocus(delta: number): KeyHandleResult {
    const count = this.#painter.focusableTaskIds().length;
    if (count === 0) return NO_CHANGE;
    const next = Math.max(0, Math.min(count - 1, this.#focusIndex + delta));
    if (next === this.#focusIndex) return NO_CHANGE;
    this.#focusIndex = next;
    return { events: [], changed: true };
  }

  #expand(): KeyHandleResult {
    if (this.#expanded) return NO_CHANGE;
    const taskId = this.focusedTaskId;
    if (taskId === undefined) return NO_CHANGE;
    this.#painter.expandTask(taskId);
    this.#expanded = true;
    return {
      events: [makeKeybindingEvent(TaskDetailExpandEvent, "task.detail.expand", taskId, this.#now())],
      changed: true,
    };
  }

  #collapse(): KeyHandleResult {
    if (!this.#expanded) return NO_CHANGE;
    const taskId = this.focusedTaskId ?? this.#painter.expandedTaskId;
    this.#painter.collapse();
    this.#expanded = false;
    if (taskId === undefined) return { events: [], changed: true };
    return {
      events: [makeKeybindingEvent(TaskDetailCollapseEvent, "task.detail.collapse", taskId, this.#now())],
      changed: true,
    };
  }
}
