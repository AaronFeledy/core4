import { describe, expect, test } from "bun:test";

import { Schema } from "effect";

import { TaskDetailEvent, TaskStartEvent, TaskTreeStartEvent } from "@lando/sdk/events";

import { wrapFrameLines } from "../src/task-tree-frame.ts";
import { TaskTreeViewModel } from "../src/task-tree-tail.ts";

/** Body-line content after the left rail, with any leftover right-hand padding stripped. */
const innerContent = (line: string): string => line.replace(/^│\s+/, "").replace(/\s*│$/, "").trim();

const ts = "2026-06-18T12:00:00.000Z";

const treeStart = (label: string, children: ReadonlyArray<string>) =>
  Schema.decodeUnknownSync(TaskTreeStartEvent)({
    _tag: "task.tree.start",
    parentId: "f",
    label,
    children,
    timestamp: ts,
  });
const start = (taskId: string, label: string) =>
  Schema.decodeUnknownSync(TaskStartEvent)({
    _tag: "task.start",
    parentId: "f",
    taskId,
    label,
    timestamp: ts,
  });
const detail = (taskId: string, line: string) =>
  Schema.decodeUnknownSync(TaskDetailEvent)({
    _tag: "task.detail",
    taskId,
    stream: "stdout",
    line,
    timestamp: ts,
  });

const assertLeftRail = (lines: ReadonlyArray<string>, columns: number): void => {
  for (const line of lines) {
    expect(Bun.stringWidth(line), `line over ${columns} cells: ${line}`).toBeLessThanOrEqual(columns);
  }
  expect(lines[0]?.startsWith("╭─")).toBe(true);
  expect(lines[0]?.endsWith("╮")).toBe(false);
  expect(lines.at(-1)?.startsWith("╰─")).toBe(true);
  expect(lines.at(-1)?.endsWith("╯")).toBe(false);
  for (const line of lines.slice(1, -1)) {
    expect(line.startsWith("│"), `missing left rail: ${line}`).toBe(true);
    expect(line.endsWith("│"), `unexpected right rail: ${line}`).toBe(false);
  }
};

describe("task-tree framing below 60 columns", () => {
  test("40-column ASCII tree stays bordered and within display width", () => {
    const painter = new TaskTreeViewModel({ terminalColumns: 40 });
    painter.apply(treeStart("Starting application services now", ["appserver", "database"]));
    painter.apply(start("appserver", "appserver bootstrapping the runtime"));
    painter.apply(detail("appserver", "listening on 0.0.0.0:8080 for incoming requests"));
    assertLeftRail(painter.snapshot().frameLines, 40);
  });

  test("40-column CJK tree counts wide glyphs and stays bordered within display width", () => {
    const painter = new TaskTreeViewModel({ terminalColumns: 40 });
    painter.apply(treeStart("한글 애플리케이션 시작 중입니다 지금", ["웹서버"]));
    painter.apply(start("웹서버", "웹서버 런타임을 부팅하는 중"));
    painter.apply(detail("웹서버", "포트 8080 에서 수신 대기 중입니다 지금"));
    const frameLines = painter.snapshot().frameLines;
    assertLeftRail(frameLines, 40);
    for (const inner of frameLines.slice(1, -1).map(innerContent)) {
      expect(inner === "중", `one-token CJK orphan row: ${inner}`).toBe(false);
    }
  });
});

describe("task-tree CJK orphan rebalancing", () => {
  test("keeps a short trailing Hangul fragment with its preceding word (부팅하는 중)", () => {
    const inners = wrapFrameLines(["│ · 웹서버 런타임을 부팅하는 중"], 40).map(innerContent);
    expect(inners).not.toContain("중");
    expect(inners.some((line) => line.includes("부팅하는 중"))).toBe(true);
  });

  test("does not split a longer CJK predicate to rescue a short trailing orphan at 40 columns", () => {
    const inners = wrapFrameLines(["│    포트 8080 에서 수신 대기 중입니다 지금"], 40).map(innerContent);
    expect(inners.some((line) => line.includes("수신 대기 중입니다"))).toBe(true);
    expect(inners.some((line) => line.includes("중입니다 지금"))).toBe(false);
  });

  test("does not rebalance ordinary ASCII wrapping", () => {
    const inners = wrapFrameLines(["│ alpha beta gamma delta epsilon zeta eta theta iota"], 40).map(
      innerContent,
    );
    expect(inners.join(" ")).toBe("alpha beta gamma delta epsilon zeta eta theta iota");
  });
});

describe("task-tree open-right left-rail chrome", () => {
  test("wrapFrameLines keeps only a left frame and no right closure or trailing fill", () => {
    const framed = wrapFrameLines(["╭─ Starting app", "│ · appserver", "│ ◌ database", "╰─ 1/2 running"], 80);

    expect(framed).toEqual(["╭─ Starting app", "│ · appserver", "│ ◌ database", "╰─ 1/2 running"]);
  });

  test("TaskTreeViewModel top/body/bottom stay open on the right at 80 columns", () => {
    const painter = new TaskTreeViewModel({ terminalColumns: 80 });
    painter.apply(treeStart("Starting app", ["appserver", "database"]));
    painter.apply(start("appserver", "appserver"));
    const lines = painter.snapshot().frameLines;
    assertLeftRail(lines, 80);
    expect(lines[0]).toBe("╭─ Starting app");
    expect(lines.at(-1)).toBe("╰─ 1/2 running");
  });
});
