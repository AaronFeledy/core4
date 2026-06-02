import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { type LandoEvent, TaskDetailEvent, TaskStartEvent, TaskTreeStartEvent } from "@lando/sdk/events";

import { DEFAULT_KEYMAP, TaskTreeInputController, parseKey } from "../../src/cli/renderer/keybindings.ts";
import { LandoTreePainter, TASK_DETAIL_TAIL_CAPACITY } from "../../src/cli/renderer/task-tree-tail.ts";

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

describe("LandoTreePainter — expand / collapse", () => {
  const seed = (painter: LandoTreePainter, taskId: string, lineCount: number): void => {
    painter.consume(treeStart("build", "Building", [taskId]));
    painter.consume(taskStart(taskId, `step ${taskId}`, "build"));
    for (let index = 0; index < lineCount; index += 1) {
      painter.consume(detail(taskId, `line-${index}`));
    }
  };

  test("collapsed by default — only the most recent 4 detail lines surface", () => {
    const painter = new LandoTreePainter();
    seed(painter, "a", 10);
    expect(painter.expandedTaskId).toBeUndefined();
    const panelLines = painter.snapshot().frameLines.filter((l) => /^\s{4,}/.test(l));
    expect(panelLines.length).toBe(TASK_DETAIL_TAIL_CAPACITY);
    expect(panelLines.some((l) => l.includes("line-0"))).toBe(false);
    expect(panelLines.some((l) => l.includes("line-9"))).toBe(true);
  });

  test("focusableTaskIds lists started tasks in order", () => {
    const painter = new LandoTreePainter();
    painter.consume(treeStart("build", "Building", ["a", "b"]));
    painter.consume(taskStart("a", "step a", "build"));
    painter.consume(taskStart("b", "step b", "build"));
    expect(painter.focusableTaskIds()).toEqual(["a", "b"]);
  });

  test("expanding a task surfaces the whole stream tail (more than the 4-line ring)", () => {
    const painter = new LandoTreePainter();
    seed(painter, "a", 10);
    painter.expandTask("a");
    expect(painter.expandedTaskId).toBe("a");
    const panelLines = painter.snapshot().frameLines.filter((l) => /^\s{4,}/.test(l));
    expect(panelLines.length).toBeGreaterThan(TASK_DETAIL_TAIL_CAPACITY);
    expect(panelLines.some((l) => l.includes("line-0"))).toBe(true);
    expect(panelLines.some((l) => l.includes("line-9"))).toBe(true);
  });

  test("expanded tail is bounded by available terminal rows", () => {
    const painter = new LandoTreePainter({ terminalRows: 6 });
    seed(painter, "a", 30);
    painter.expandTask("a");
    const panelLines = painter.snapshot().frameLines.filter((l) => /^\s{4,}/.test(l));
    expect(panelLines.length).toBeLessThanOrEqual(6);
    expect(panelLines.length).toBeGreaterThan(TASK_DETAIL_TAIL_CAPACITY);
    expect(panelLines.some((l) => l.includes("line-29"))).toBe(true);
  });

  test("collapsing restores the 4-line ring", () => {
    const painter = new LandoTreePainter();
    seed(painter, "a", 10);
    painter.expandTask("a");
    painter.collapse();
    expect(painter.expandedTaskId).toBeUndefined();
    const panelLines = painter.snapshot().frameLines.filter((l) => /^\s{4,}/.test(l));
    expect(panelLines.length).toBe(TASK_DETAIL_TAIL_CAPACITY);
    expect(panelLines.some((l) => l.includes("line-0"))).toBe(false);
  });
});

describe("TaskTreeInputController", () => {
  const fixedClock = () => "2026-05-19T12:00:00.000Z";

  const make = (taskIds: ReadonlyArray<string>) => {
    const painter = new LandoTreePainter();
    painter.consume(treeStart("build", "Building", taskIds));
    for (const id of taskIds) painter.consume(taskStart(id, `step ${id}`, "build"));
    for (const id of taskIds) {
      for (let n = 0; n < 8; n += 1) painter.consume(detail(id, `${id}-line-${n}`));
    }
    const controller = new TaskTreeInputController(painter, { now: fixedClock });
    return { painter, controller };
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
    const { painter, controller } = make(["a", "b"]);
    controller.handleKey("down");
    const result = controller.handleKey("enter");
    expect(result.changed).toBe(true);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?._tag).toBe("task.detail.expand");
    expect((result.events[0] as { taskId: string }).taskId).toBe("b");
    expect(painter.expandedTaskId).toBe("b");
  });

  test("Esc collapses and emits task.detail.collapse for the expanded task", () => {
    const { painter, controller } = make(["a"]);
    controller.handleKey("enter");
    expect(painter.expandedTaskId).toBe("a");
    const result = controller.handleKey("esc");
    expect(result.changed).toBe(true);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?._tag).toBe("task.detail.collapse");
    expect((result.events[0] as { taskId: string }).taskId).toBe("a");
    expect(painter.expandedTaskId).toBeUndefined();
  });

  test("Esc emits collapse for the expanded task after focus moves", () => {
    const { painter, controller } = make(["a", "b"]);
    controller.handleKey("down");
    controller.handleKey("enter");
    expect(painter.expandedTaskId).toBe("b");
    controller.handleKey("up");
    expect(controller.focusedTaskId).toBe("a");
    const result = controller.handleKey("esc");
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?._tag).toBe("task.detail.collapse");
    expect((result.events[0] as { taskId: string }).taskId).toBe("b");
    expect(painter.expandedTaskId).toBeUndefined();
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

  test("unknown keys are a no-op", () => {
    const { controller } = make(["a"]);
    const result = controller.handleKey("unknown");
    expect(result.changed).toBe(false);
    expect(result.events).toHaveLength(0);
  });

  test("handleInput parses raw bytes then drives the state machine", () => {
    const { painter, controller } = make(["a"]);
    const result = controller.handleInput("\r");
    expect(result.changed).toBe(true);
    expect(result.events[0]?._tag).toBe("task.detail.expand");
    expect(painter.expandedTaskId).toBe("a");
  });
});
