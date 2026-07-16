import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import {
  type LandoEvent,
  TaskCompleteEvent,
  TaskDetailEvent,
  TaskStartEvent,
  TaskTreeStartEvent,
} from "@lando/sdk/events";

import { DEFAULT_KEYMAP, TaskTreeInputController, parseKey } from "../../src/cli/renderer/keybindings.ts";
import { TASK_DETAIL_TAIL_CAPACITY, TaskTreeViewModel } from "../../src/cli/renderer/task-tree-tail.ts";

const ts = "2026-05-19T12:00:00.000Z";

const treeStart = (parentId: string, label: string, children: ReadonlyArray<string>): LandoEvent =>
  Schema.decodeUnknownSync(TaskTreeStartEvent)({
    _tag: "task.tree.start",
    parentId,
    label,
    children,
    timestamp: ts,
  });

const taskStart = (taskId: string, label: string, parentId?: string): LandoEvent =>
  Schema.decodeUnknownSync(TaskStartEvent)({
    _tag: "task.start",
    taskId,
    ...(parentId === undefined ? {} : { parentId }),
    label,
    timestamp: ts,
  });

const detail = (taskId: string, line: string): LandoEvent =>
  Schema.decodeUnknownSync(TaskDetailEvent)({
    _tag: "task.detail",
    taskId,
    stream: "stdout",
    line,
    timestamp: ts,
  });

const taskComplete = (taskId: string): LandoEvent =>
  Schema.decodeUnknownSync(TaskCompleteEvent)({
    _tag: "task.complete",
    taskId,
    timestamp: ts,
  });

describe("parseKey", () => {
  test("decodes arrow-up / arrow-down CSI sequences", () => {
    expect(parseKey("\x1b[A")).toBe("up");
    expect(parseKey("\x1b[B")).toBe("down");
  });

  test("decodes Enter from carriage-return and newline", () => {
    expect(parseKey("\r")).toBe("enter");
    expect(parseKey("\n")).toBe("enter");
  });

  test("decodes a lone Escape distinctly from a CSI sequence", () => {
    expect(parseKey("\x1b")).toBe("esc");
    expect(parseKey("\x1b[A")).not.toBe("esc");
  });

  test("decodes Tab", () => {
    expect(parseKey("\t")).toBe("tab");
  });

  test("classifies unmapped input as unknown", () => {
    expect(parseKey("x")).toBe("unknown");
    expect(parseKey("\x1b[C")).toBe("unknown");
    expect(parseKey("")).toBe("unknown");
  });
});

describe("DEFAULT_KEYMAP", () => {
  test("binds focus / cycle / expand / collapse per the default scheme", () => {
    expect(DEFAULT_KEYMAP.up).toBe("focus.up");
    expect(DEFAULT_KEYMAP.down).toBe("focus.down");
    expect(DEFAULT_KEYMAP.tab).toBe("tree.cycle");
    expect(DEFAULT_KEYMAP.enter).toBe("detail.expand");
    expect(DEFAULT_KEYMAP.esc).toBe("detail.collapse");
    expect(DEFAULT_KEYMAP.unknown).toBeNull();
  });
});

describe("TaskTreeViewModel — expand / collapse", () => {
  const seed = (vm: TaskTreeViewModel, taskId: string, lineCount: number): void => {
    vm.apply(treeStart("build", "Building", [taskId]));
    vm.apply(taskStart(taskId, `step ${taskId}`, "build"));
    for (let index = 0; index < lineCount; index += 1) {
      vm.apply(detail(taskId, `line-${index}`));
    }
  };

  test("collapsed by default — only the most recent 4 detail lines surface", () => {
    const vm = new TaskTreeViewModel();
    seed(vm, "a", 10);
    expect(vm.expandedTaskId).toBeUndefined();
    const panelLines = vm.snapshot().frameLines.filter((l) => l.includes("line-"));
    expect(panelLines.length).toBe(TASK_DETAIL_TAIL_CAPACITY);
    expect(panelLines.some((l) => l.includes("line-0"))).toBe(false);
    expect(panelLines.some((l) => l.includes("line-9"))).toBe(true);
  });

  test("focusableTaskIds lists started tasks in order", () => {
    const vm = new TaskTreeViewModel();
    vm.apply(treeStart("build", "Building", ["a", "b"]));
    vm.apply(taskStart("a", "step a", "build"));
    vm.apply(taskStart("b", "step b", "build"));
    expect(vm.focusableTaskIds()).toEqual(["a", "b"]);
  });

  test("expanding a task surfaces the whole stream tail (more than the 4-line ring)", () => {
    const vm = new TaskTreeViewModel();
    seed(vm, "a", 10);
    vm.expandTask("a");
    expect(vm.expandedTaskId).toBe("a");
    const panelLines = vm.snapshot().frameLines.filter((l) => l.includes("line-"));
    expect(panelLines.length).toBeGreaterThan(TASK_DETAIL_TAIL_CAPACITY);
    expect(panelLines.some((l) => l.includes("line-0"))).toBe(true);
    expect(panelLines.some((l) => l.includes("line-9"))).toBe(true);
  });

  test("expanded tail is bounded by available terminal rows", () => {
    const vm = new TaskTreeViewModel({ terminalRows: 6 });
    seed(vm, "a", 30);
    vm.expandTask("a");
    const panelLines = vm.snapshot().frameLines.filter((l) => l.includes("line-"));
    expect(panelLines.length).toBeLessThanOrEqual(6);
    expect(panelLines.length).toBeGreaterThan(TASK_DETAIL_TAIL_CAPACITY);
    expect(panelLines.some((l) => l.includes("line-29"))).toBe(true);
  });

  test("collapsing restores the 4-line ring", () => {
    const vm = new TaskTreeViewModel();
    seed(vm, "a", 10);
    vm.expandTask("a");
    vm.collapse();
    expect(vm.expandedTaskId).toBeUndefined();
    const panelLines = vm.snapshot().frameLines.filter((l) => l.includes("line-"));
    expect(panelLines.length).toBe(TASK_DETAIL_TAIL_CAPACITY);
    expect(panelLines.some((l) => l.includes("line-0"))).toBe(false);
  });

  test("finished tasks cannot be expanded", () => {
    const vm = new TaskTreeViewModel();
    seed(vm, "a", 10);
    vm.apply(taskComplete("a"));
    expect(vm.canExpandTask("a")).toBe(false);
    vm.expandTask("a");
    expect(vm.expandedTaskId).toBeUndefined();
  });

  test("completion clears the expanded task", () => {
    const vm = new TaskTreeViewModel();
    seed(vm, "a", 10);
    vm.expandTask("a");
    expect(vm.expandedTaskId).toBe("a");
    vm.apply(taskComplete("a"));
    expect(vm.expandedTaskId).toBeUndefined();
  });
});

describe("TaskTreeInputController", () => {
  const fixedClock = () => "2026-05-19T12:00:00.000Z";

  const make = (taskIds: ReadonlyArray<string>) => {
    const vm = new TaskTreeViewModel();
    vm.apply(treeStart("build", "Building", taskIds));
    for (const id of taskIds) vm.apply(taskStart(id, `step ${id}`, "build"));
    for (const id of taskIds) {
      for (let n = 0; n < 8; n += 1) vm.apply(detail(id, `${id}-line-${n}`));
    }
    const controller = new TaskTreeInputController(vm, { now: fixedClock });
    return { vm, controller };
  };

  test("focus starts on the first task and moves with down/up", () => {
    const { controller } = make(["a", "b", "c"]);
    expect(controller.focusedTaskId).toBe("a");
    expect(controller.handleKey("down").changed).toBe(true);
    expect(controller.focusedTaskId).toBe("b");
    controller.handleKey("down");
    expect(controller.focusedTaskId).toBe("c");
    expect(controller.handleKey("down").changed).toBe(false);
    expect(controller.focusedTaskId).toBe("c");
    controller.handleKey("up");
    expect(controller.focusedTaskId).toBe("b");
  });

  test("Enter expands the focused task and emits task.detail.expand", () => {
    const { vm, controller } = make(["a", "b"]);
    controller.handleKey("down");
    const result = controller.handleKey("enter");
    expect(result.changed).toBe(true);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?._tag).toBe("task.detail.expand");
    expect((result.events[0] as { taskId: string }).taskId).toBe("b");
    expect(vm.expandedTaskId).toBe("b");
  });

  test("Esc collapses and emits task.detail.collapse for the expanded task", () => {
    const { vm, controller } = make(["a"]);
    controller.handleKey("enter");
    expect(vm.expandedTaskId).toBe("a");
    const result = controller.handleKey("esc");
    expect(result.changed).toBe(true);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?._tag).toBe("task.detail.collapse");
    expect((result.events[0] as { taskId: string }).taskId).toBe("a");
    expect(vm.expandedTaskId).toBeUndefined();
  });

  test("Esc emits collapse for the expanded task after focus moves", () => {
    const { vm, controller } = make(["a", "b"]);
    controller.handleKey("down");
    controller.handleKey("enter");
    expect(vm.expandedTaskId).toBe("b");
    controller.handleKey("up");
    expect(controller.focusedTaskId).toBe("a");
    const result = controller.handleKey("esc");
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?._tag).toBe("task.detail.collapse");
    expect((result.events[0] as { taskId: string }).taskId).toBe("b");
    expect(vm.expandedTaskId).toBeUndefined();
  });

  test("Esc when not expanded is a no-op (no event, no change)", () => {
    const { controller } = make(["a"]);
    const result = controller.handleKey("esc");
    expect(result.changed).toBe(false);
    expect(result.events).toHaveLength(0);
  });

  test("Enter when already expanded does not emit a second expand", () => {
    const { controller } = make(["a"]);
    controller.handleKey("enter");
    const second = controller.handleKey("enter");
    expect(second.changed).toBe(false);
    expect(second.events).toHaveLength(0);
  });

  test("Enter on a finished task is a no-op", () => {
    const { vm, controller } = make(["a"]);
    vm.apply(taskComplete("a"));
    const result = controller.handleKey("enter");
    expect(result.changed).toBe(false);
    expect(result.events).toHaveLength(0);
    expect(vm.expandedTaskId).toBeUndefined();
  });

  test("completion unlocks the controller for another expansion", () => {
    const { vm, controller } = make(["a", "b"]);
    controller.handleKey("enter");
    expect(vm.expandedTaskId).toBe("a");
    vm.apply(taskComplete("a"));
    controller.handleKey("down");
    const result = controller.handleKey("enter");
    expect(result.changed).toBe(true);
    expect(result.events[0]?._tag).toBe("task.detail.expand");
    expect((result.events[0] as { taskId: string }).taskId).toBe("b");
    expect(vm.expandedTaskId).toBe("b");
  });

  test("unknown keys are a no-op", () => {
    const { controller } = make(["a"]);
    const result = controller.handleKey("unknown");
    expect(result.changed).toBe(false);
    expect(result.events).toHaveLength(0);
  });

  test("handleInput parses raw bytes then drives the state machine", () => {
    const { vm, controller } = make(["a"]);
    const result = controller.handleInput("\r");
    expect(result.changed).toBe(true);
    expect(result.events[0]?._tag).toBe("task.detail.expand");
    expect(vm.expandedTaskId).toBe("a");
  });
});
