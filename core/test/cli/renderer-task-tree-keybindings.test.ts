import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import {
  type LandoEvent,
  TaskDetailEvent,
  TaskStartEvent,
  TaskTreeStartEvent,
} from "@lando/sdk/events";

import { DEFAULT_KEYMAP, parseKey } from "../../src/cli/renderer/keybindings.ts";
import {
  LandoTreePainter,
  TASK_DETAIL_TAIL_CAPACITY,
} from "../../src/cli/renderer/task-tree-tail.ts";

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
    // Earliest retained line is now visible.
    expect(panelLines.some((l) => l.includes("line-0"))).toBe(true);
    expect(panelLines.some((l) => l.includes("line-9"))).toBe(true);
  });

  test("expanded tail is bounded by available terminal rows", () => {
    const painter = new LandoTreePainter({ terminalRows: 6 });
    seed(painter, "a", 30);
    painter.expandTask("a");
    const panelLines = painter.snapshot().frameLines.filter((l) => /^\s{4,}/.test(l));
    // Bounded well under the 30 retained lines by the 6-row terminal.
    expect(panelLines.length).toBeLessThanOrEqual(6);
    expect(panelLines.length).toBeGreaterThan(TASK_DETAIL_TAIL_CAPACITY);
    // Most-recent lines are kept when bounded.
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
})
