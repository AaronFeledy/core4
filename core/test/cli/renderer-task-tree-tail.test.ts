import { describe, expect, test } from "bun:test";
import { Layer, Schema } from "effect";

import {
  type LandoEvent,
  TaskCompleteEvent,
  TaskDetailEvent,
  TaskFailEvent,
  TaskStartEvent,
  TaskTreeCompleteEvent,
  TaskTreeStartEvent,
} from "@lando/sdk/events";
import { Effect } from "effect";

import { EventService } from "@lando/sdk/services";

import { landoRenderer } from "../../src/cli/renderer/bundled-renderers.ts";
import { createBufferedRendererIO } from "../../src/cli/renderer/io.ts";
import {
  LandoTreePainter,
  TASK_DETAIL_TAIL_CAPACITY,
  TaskDetailRing,
  csi,
} from "../../src/cli/renderer/task-tree-tail.ts";
import { EventServiceLive } from "../../src/services/event-service.ts";

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

const detail = (taskId: string, line: string, stream: "stdout" | "stderr" = "stdout"): LandoEvent =>
  Schema.decodeUnknownSync(TaskDetailEvent)({
    _tag: "task.detail",
    taskId,
    stream,
    line,
    timestamp: ts,
  });

const taskComplete = (taskId: string, summary?: string, durationMs?: number): LandoEvent =>
  Schema.decodeUnknownSync(TaskCompleteEvent)({
    _tag: "task.complete",
    taskId,
    ...(summary === undefined ? {} : { summary }),
    ...(durationMs === undefined ? {} : { durationMs }),
    timestamp: ts,
  });

const taskFail = (taskId: string, summary?: string, exitCode?: number, remediation?: string): LandoEvent =>
  Schema.decodeUnknownSync(TaskFailEvent)({
    _tag: "task.fail",
    taskId,
    ...(summary === undefined ? {} : { summary }),
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(remediation === undefined ? {} : { remediation }),
    timestamp: ts,
  });

const treeComplete = (
  parentId: string,
  summary: string,
  succeeded: number,
  failed: number,
  durationMs?: number,
): LandoEvent =>
  Schema.decodeUnknownSync(TaskTreeCompleteEvent)({
    _tag: "task.tree.complete",
    parentId,
    summary,
    succeeded,
    failed,
    ...(durationMs === undefined ? {} : { durationMs }),
    timestamp: ts,
  });

// Strip every CSI sequence so logical content can be asserted independently of
// the cursor/erase control bytes.
const stripCsi = (text: string): string => {
  const esc = String.fromCharCode(27);
  const pattern = new RegExp(`${esc}\\[[0-9;]*[A-Za-z]`, "g");
  return text.replace(pattern, "");
};

const cursorUpAtStartPattern = new RegExp(`^${String.fromCharCode(27)}\\[\\d+A`);

describe("TaskDetailRing", () => {
  test("default capacity is 4", () => {
    expect(TASK_DETAIL_TAIL_CAPACITY).toBe(4);
    const ring = new TaskDetailRing();
    for (let index = 0; index < 10; index += 1) ring.push(`line-${index}`);
    expect(ring.lines().length).toBe(4);
  });

  test("wraps oldest-out at exactly 4, most-recent-last", () => {
    const ring = new TaskDetailRing();
    ring.push("a");
    ring.push("b");
    ring.push("c");
    ring.push("d");
    expect(ring.lines()).toEqual(["a", "b", "c", "d"]);
    expect(ring.count).toBe(4);
    ring.push("e");
    expect(ring.lines()).toEqual(["b", "c", "d", "e"]);
    expect(ring.count).toBe(4);
    ring.push("f");
    expect(ring.lines()).toEqual(["c", "d", "e", "f"]);
  });

  test("fewer than capacity returns all in order", () => {
    const ring = new TaskDetailRing();
    ring.push("only");
    expect(ring.lines()).toEqual(["only"]);
    expect(ring.count).toBe(1);
  });
});

describe("LandoTreePainter — tail panel", () => {
  test("surfaces the most recent 4 detail lines as an indented panel", () => {
    const painter = new LandoTreePainter();
    painter.consume(treeStart("build", "Building", ["a"]));
    painter.consume(taskStart("a", "step a", "build"));
    for (const line of ["l1", "l2", "l3", "l4", "l5", "l6"]) {
      painter.consume(detail("a", line));
    }
    const frame = painter.snapshot().frameLines;
    const joined = frame.join("\n");
    expect(joined).not.toContain("l1");
    expect(joined).not.toContain("l2");
    for (const line of ["l3", "l4", "l5", "l6"]) {
      expect(joined.includes(line)).toBe(true);
    }
    const panelLines = frame.filter((l) => /^\s{4,}/.test(l));
    expect(panelLines.length).toBeLessThanOrEqual(TASK_DETAIL_TAIL_CAPACITY);
  });

  test("collapses the panel on task.complete leaving only a summary line", () => {
    const painter = new LandoTreePainter();
    painter.consume(treeStart("build", "Building", ["a"]));
    painter.consume(taskStart("a", "step a", "build"));
    painter.consume(detail("a", "compiling..."));
    painter.consume(detail("a", "linking..."));
    const before = painter.snapshot().frameLines.join("\n");
    expect(before).toContain("linking...");

    painter.consume(taskComplete("a", "step a", 12400));
    const after = painter.snapshot();
    const joined = after.frameLines.join("\n");
    expect(joined).not.toContain("compiling...");
    expect(joined).not.toContain("linking...");
    expect(joined).toContain("✓");
    expect(after.activeTaskIds).not.toContain("a");
  });

  test("collapses the panel on task.fail and marks the task failed", () => {
    const painter = new LandoTreePainter();
    painter.consume(treeStart("build", "Building", ["a"]));
    painter.consume(taskStart("a", "npm ci", "build"));
    painter.consume(detail("a", "downloading..."));
    painter.consume(taskFail("a", "npm ci", 1, "see lando logs a --build"));
    const joined = painter.snapshot().frameLines.join("\n");
    expect(joined).not.toContain("downloading...");
    expect(joined).toContain("✗");
    expect(painter.snapshot().activeTaskIds).not.toContain("a");
  });
});

describe("LandoTreePainter — tree start metadata", () => {
  test("uses declared tree children as the running denominator before all siblings start", () => {
    const painter = new LandoTreePainter();
    painter.consume(treeStart("build", "Building", ["a", "b", "c", "d"]));
    expect(painter.snapshot().frameLines[0]).toContain("(0/4 running)");

    painter.consume(taskStart("a", "step a", "build"));
    expect(painter.snapshot().frameLines[0]).toContain("(1/4 running)");
  });
});

describe("LandoTreePainter — CSI cursor handling", () => {
  test("first paint emits no cursor-up (no prior frame)", () => {
    const painter = new LandoTreePainter();
    const out = painter.consume(treeStart("build", "Building", ["a"]));
    expect(out.match(cursorUpAtStartPattern)).toBeNull();
    expect(out.endsWith("\n")).toBe(true);
  });

  test("a subsequent event moves the cursor up by the previous frame height then repaints", () => {
    const painter = new LandoTreePainter();
    const first = painter.consume(treeStart("build", "Building", ["a"]));
    const firstFrameHeight = stripCsi(first)
      .split("\n")
      .filter((l) => l.length > 0).length;
    expect(firstFrameHeight).toBeGreaterThan(0);

    const second = painter.consume(taskStart("a", "step a", "build"));
    expect(second.startsWith(csi.cursorUp(firstFrameHeight))).toBe(true);
    expect(second.includes(csi.eraseDown)).toBe(true);
  });

  test("rewinds by physical rows for wrapped and multiline frame entries", () => {
    const painter = new LandoTreePainter({ terminalColumns: 20 });
    painter.consume(treeStart("build", "Run", ["a"]));
    painter.consume(taskStart("a", "a", "build"));
    painter.consume(detail("a", "123456789012345678901\nx"));

    const collapse = painter.consume(taskComplete("a", "a", 10));

    expect(collapse.startsWith(csi.cursorUp(8))).toBe(true);
    expect(collapse.startsWith(csi.cursorUp(3))).toBe(false);
  });

  test("rewinds by physical rows using the current terminal width", () => {
    let columns = 80;
    const painter = new LandoTreePainter({ getTerminalColumns: () => columns });
    painter.consume(treeStart("build", "Run", ["a"]));
    painter.consume(taskStart("a", "a", "build"));
    painter.consume(detail("a", "1234567890123456789012345678901"));

    columns = 10;
    const collapse = painter.consume(taskComplete("a", "a", 10));

    expect(collapse.startsWith(csi.cursorUp(32))).toBe(true);
    expect(collapse.startsWith(csi.cursorUp(3))).toBe(false);
  });

  test("redraw clears downward so a collapsing frame leaves no stale panel rows", () => {
    const painter = new LandoTreePainter();
    painter.consume(treeStart("build", "Building", ["a"]));
    painter.consume(taskStart("a", "step a", "build"));
    painter.consume(detail("a", "l1"));
    painter.consume(detail("a", "l2"));
    const collapse = painter.consume(taskComplete("a", "step a", 10));
    expect(collapse.includes(csi.eraseDown)).toBe(true);
    expect(collapse.endsWith("\n")).toBe(true);
  });

  test("detail panel lines are dimmed", () => {
    const painter = new LandoTreePainter();
    painter.consume(treeStart("build", "Building", ["a"]));
    painter.consume(taskStart("a", "step a", "build"));
    const out = painter.consume(detail("a", "hello"));
    expect(out.includes(csi.dim)).toBe(true);
    expect(out.includes(csi.dimReset)).toBe(true);
  });
});

describe("LandoTreePainter — concurrent sibling panels", () => {
  test("keeps a tail panel for each running sibling via full-frame redraw", () => {
    const painter = new LandoTreePainter();
    painter.consume(treeStart("build", "Building", ["a", "b"]));
    painter.consume(taskStart("a", "step a", "build"));
    painter.consume(taskStart("b", "step b", "build"));
    painter.consume(detail("a", "a-line-1"));
    painter.consume(detail("b", "b-line-1"));
    painter.consume(detail("a", "a-line-2"));
    const joined = painter.snapshot().frameLines.join("\n");
    expect(joined).toContain("a-line-2");
    expect(joined).toContain("b-line-1");
    expect(painter.snapshot().activeTaskIds.length).toBe(2);
  });

  test("tree.complete collapses to a passive summary line", () => {
    const painter = new LandoTreePainter();
    painter.consume(treeStart("build", "Building", ["a", "b"]));
    painter.consume(taskStart("a", "step a", "build"));
    painter.consume(taskStart("b", "step b", "build"));
    painter.consume(detail("a", "x"));
    painter.consume(taskComplete("a", "step a", 10));
    painter.consume(taskComplete("b", "step b", 12));
    const summary = painter.consume(treeComplete("build", "Built app dependencies", 2, 0, 12400));
    const joined = stripCsi(summary);
    expect(joined).toContain("2 ✓");
    expect(joined).toContain("0 ✗");
    expect(joined).toContain("(12.4s)");
    expect(painter.snapshot().frameLines[0]).toContain("(12.4s)");
    expect(painter.snapshot().activeTaskIds.length).toBe(0);
  });

  test("tree.complete hides pending placeholders for children that never started", () => {
    const painter = new LandoTreePainter();
    painter.consume(treeStart("build", "Building", ["a", "b"]));
    painter.consume(taskStart("a", "step a", "build"));
    painter.consume(taskFail("a", "step a failed", 1));
    painter.consume(treeComplete("build", "Build failed", 0, 1, 50));
    const frame = painter.snapshot().frameLines;
    expect(frame.join("\n")).toContain("[BLOCKED] Build failed");
    expect(frame.join("\n")).toContain("[BLOCKED] ✗ step a failed");
    expect(frame.join("\n")).not.toContain("[WAIT]");
    expect(new Set(frame.map((line) => line.length)).size).toBe(1);
  });
});

describe("LandoTreePainter — cached/skipped badges", () => {
  const completeWith = (summary: string, durationMs = 12400): string => {
    const painter = new LandoTreePainter();
    painter.consume(treeStart("build", "Building", ["a"]));
    painter.consume(taskStart("a", "step a", "build"));
    painter.consume(taskComplete("a", summary, durationMs));
    return painter.snapshot().frameLines.join("\n");
  };

  test("renders a [CACHED] badge, keeps the success glyph, and strips the parenthetical marker", () => {
    const frame = completeWith("composer install (cached)");
    expect(frame).toContain("[CACHED] ✓ composer install");
    expect(frame).toContain("(12.4s)");
    expect(frame).not.toContain("[ONLINE]");
    expect(frame).not.toContain("(cached)");
  });

  test("renders a [CACHED] badge for the cockpit `· cached` marker form", () => {
    const frame = completeWith("deps · cached");
    expect(frame).toContain("[CACHED] ✓ deps");
    expect(frame).not.toContain("· cached");
  });

  test("renders a [SKIPPED] badge and strips the parenthetical marker", () => {
    const frame = completeWith("run migrations (skipped)");
    expect(frame).toContain("[SKIPPED] ✓ run migrations");
    expect(frame).not.toContain("[ONLINE]");
    expect(frame).not.toContain("(skipped)");
  });

  test("renders a [SKIPPED] badge for the cockpit `· skipped` marker form", () => {
    const frame = completeWith("seed · skipped");
    expect(frame).toContain("[SKIPPED] ✓ seed");
  });

  test("matches the cached/skipped marker case-insensitively", () => {
    expect(completeWith("Build (CACHED)")).toContain("[CACHED] ✓ Build");
    expect(completeWith("Build (Skipped)")).toContain("[SKIPPED] ✓ Build");
  });

  test("does not treat undelimited prose as a badge (no false positives)", () => {
    expect(completeWith("warm cache")).toContain("[ONLINE] ✓ warm cache");
    expect(completeWith("warm cache")).not.toContain("[CACHED]");
    expect(completeWith("skipped migrations were applied")).toContain("[ONLINE]");
    expect(completeWith("skipped migrations were applied")).not.toContain("[SKIPPED]");
  });

  test("a child whose label is literally 'cache' stays ONLINE without a marker", () => {
    const painter = new LandoTreePainter();
    painter.consume(treeStart("build", "Building", ["cache"]));
    painter.consume(taskStart("cache", "cache", "build"));
    painter.consume(taskComplete("cache", "cache", 500));
    const frame = painter.snapshot().frameLines.join("\n");
    expect(frame).toContain("[ONLINE] ✓ cache");
    expect(frame).not.toContain("[CACHED]");
  });

  test("falls back to the task label when stripping the marker empties the summary", () => {
    const painter = new LandoTreePainter();
    painter.consume(treeStart("build", "Building", ["a"]));
    painter.consume(taskStart("a", "warm step", "build"));
    painter.consume(taskComplete("a", "(cached)", 100));
    const frame = painter.snapshot().frameLines.join("\n");
    expect(frame).toContain("[CACHED] ✓ warm step");
  });

  test("cached and skipped rows are color-accented in TTY but never status-by-color-only", () => {
    const painter = new LandoTreePainter();
    painter.consume(treeStart("build", "Building", ["a", "b"]));
    painter.consume(taskStart("a", "a", "build"));
    painter.consume(taskStart("b", "b", "build"));
    const cachedFrame = painter.consume(taskComplete("a", "a (cached)", 10));
    const skippedFrame = painter.consume(taskComplete("b", "b (skipped)", 10));
    expect(cachedFrame.includes(String.fromCharCode(27))).toBe(true);
    expect(stripCsi(skippedFrame)).toContain("[CACHED]");
    expect(stripCsi(skippedFrame)).toContain("[SKIPPED]");
  });
});

describe("lando renderer (TTY vs non-TTY selection)", () => {
  const drive = (events: ReadonlyArray<LandoEvent>) =>
    Effect.gen(function* () {
      const svc = yield* EventService;
      for (const event of events) yield* svc.publish(event);
      yield* Effect.sleep("20 millis");
    });

  test("non-TTY IO falls back to the plain line renderer (no CSI cursor codes)", async () => {
    const io = createBufferedRendererIO();
    const events = [
      treeStart("build", "Building", ["a"]),
      taskStart("a", "step a", "build"),
      detail("a", "hello"),
      taskComplete("a", "step a", 10),
      treeComplete("build", "Built", 1, 0),
    ];
    const layer = Layer.provideMerge(landoRenderer.makeEventConsumer(io), EventServiceLive);
    await Effect.runPromise(Effect.scoped(drive(events).pipe(Effect.provide(layer))));
    const out = io.stdout();
    expect(out.includes(csi.eraseDown)).toBe(false);
    expect(out).toContain("[a] start");
    expect(out).toContain("[a] hello");
  });

  test("TTY IO engages the painter (emits CSI cursor/erase control codes)", async () => {
    const buffered = createBufferedRendererIO();
    const io = { ...buffered, isTTY: true };
    const events = [
      treeStart("build", "Building", ["a"]),
      taskStart("a", "step a", "build"),
      detail("a", "hello"),
      taskComplete("a", "step a", 10),
    ];
    const layer = Layer.provideMerge(landoRenderer.makeEventConsumer(io), EventServiceLive);
    await Effect.runPromise(Effect.scoped(drive(events).pipe(Effect.provide(layer))));
    const out = buffered.stdout();
    expect(out.includes(csi.eraseDown)).toBe(true);
    expect(stripCsi(out)).toContain("hello");
  });
});
