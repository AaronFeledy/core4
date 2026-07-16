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
  TASK_DETAIL_TAIL_CAPACITY,
  TaskDetailRing,
  TaskTreeViewModel,
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

const stripCsi = (text: string): string => {
  const esc = String.fromCharCode(27);
  const pattern = new RegExp(`${esc}\\[[0-9;]*[A-Za-z]`, "g");
  return text.replace(pattern, "");
};

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

describe("TaskTreeViewModel — tail panel", () => {
  test("surfaces the most recent 4 detail lines as an indented panel", () => {
    const painter = new TaskTreeViewModel();
    painter.apply(treeStart("build", "Building", ["a"]));
    painter.apply(taskStart("a", "step a", "build"));
    for (const line of ["l1", "l2", "l3", "l4", "l5", "l6"]) {
      painter.apply(detail("a", line));
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
    const painter = new TaskTreeViewModel();
    painter.apply(treeStart("build", "Building", ["a"]));
    painter.apply(taskStart("a", "step a", "build"));
    painter.apply(detail("a", "compiling..."));
    painter.apply(detail("a", "linking..."));
    const before = painter.snapshot().frameLines.join("\n");
    expect(before).toContain("linking...");

    painter.apply(taskComplete("a", "step a", 12400));
    const after = painter.snapshot();
    const joined = after.frameLines.join("\n");
    expect(joined).not.toContain("compiling...");
    expect(joined).not.toContain("linking...");
    expect(joined).toContain("✓");
    expect(after.activeTaskIds).not.toContain("a");
  });

  test("collapses the panel on task.fail and marks the task failed", () => {
    const painter = new TaskTreeViewModel();
    painter.apply(treeStart("build", "Building", ["a"]));
    painter.apply(taskStart("a", "npm ci", "build"));
    painter.apply(detail("a", "downloading..."));
    painter.apply(taskFail("a", "npm ci", 1, "see lando logs a --build"));
    const joined = painter.snapshot().frameLines.join("\n");
    expect(joined).not.toContain("downloading...");
    expect(joined).toContain("✗");
    expect(painter.snapshot().activeTaskIds).not.toContain("a");
  });
});

describe("TaskTreeViewModel — tree start metadata", () => {
  test("uses declared tree children as the running denominator before all siblings start", () => {
    const painter = new TaskTreeViewModel();
    painter.apply(treeStart("build", "Building", ["a", "b", "c", "d"]));
    expect(painter.snapshot().frameLines[0]).toContain("(0/4 running)");

    painter.apply(taskStart("a", "step a", "build"));
    expect(painter.snapshot().frameLines[0]).toContain("(1/4 running)");
  });
});

describe("TaskTreeViewModel — frame content", () => {
  test("first paint exposes styled and logical lines for the same frame", () => {
    const painter = new TaskTreeViewModel();
    painter.apply(treeStart("build", "Building", ["a"]));
    expect(painter.frameLines().map(stripCsi)).toEqual([...painter.snapshot().frameLines]);
    expect(painter.snapshot().frameLines.join("\n")).toContain("◌ a");
  });

  test("a subsequent event replaces the pending row with running task content", () => {
    const painter = new TaskTreeViewModel();
    painter.apply(treeStart("build", "Building", ["a"]));
    expect(painter.snapshot().frameLines.join("\n")).toContain("◌ a");
    painter.apply(taskStart("a", "step a", "build"));
    const second = painter.snapshot().frameLines.join("\n");
    expect(second).toContain("· step a");
    expect(second).not.toContain("◌ a");
  });

  test("wraps long detail rows to the configured physical width", () => {
    const painter = new TaskTreeViewModel({ terminalColumns: 60 });
    painter.apply(treeStart("build", "Run", ["a"]));
    painter.apply(taskStart("a", "a", "build"));
    painter.apply(detail("a", "abcdefghij ".repeat(12).trim()));
    expect(painter.snapshot().frameLines.every((line) => line.length <= 60)).toBe(true);
  });

  test("wraps using the current terminal width read live on each render", () => {
    let columns = 120;
    const painter = new TaskTreeViewModel({ getTerminalColumns: () => columns });
    painter.apply(treeStart("build", "Run", ["a"]));
    painter.apply(taskStart("a", "a", "build"));
    painter.apply(detail("a", "abcdefghij ".repeat(12).trim()));
    columns = 60;
    expect(painter.snapshot().frameLines.every((line) => line.length <= 60)).toBe(true);
  });

  test("a collapsing frame leaves no stale panel content", () => {
    const painter = new TaskTreeViewModel();
    painter.apply(treeStart("build", "Building", ["a"]));
    painter.apply(taskStart("a", "step a", "build"));
    painter.apply(detail("a", "l1"));
    painter.apply(detail("a", "l2"));
    const expandedHeight = painter.snapshot().frameLines.length;
    painter.apply(taskComplete("a", "step a", 10));
    const collapse = painter.snapshot().frameLines;
    expect(collapse.length).toBeLessThan(expandedHeight);
    expect(collapse.join("\n")).not.toContain("l1");
    expect(collapse.join("\n")).not.toContain("l2");
  });

  test("detail panel lines are dimmed", () => {
    const painter = new TaskTreeViewModel();
    painter.apply(treeStart("build", "Building", ["a"]));
    painter.apply(taskStart("a", "step a", "build"));
    painter.apply(detail("a", "hello"));
    const out = painter.frameLines().join("\n");
    expect(out.includes(csi.dim)).toBe(true);
    expect(out.includes(csi.dimReset)).toBe(true);
  });
});

describe("TaskTreeViewModel — concurrent sibling panels", () => {
  test("keeps a tail panel for each running sibling in the current frame", () => {
    const painter = new TaskTreeViewModel();
    painter.apply(treeStart("build", "Building", ["a", "b"]));
    painter.apply(taskStart("a", "step a", "build"));
    painter.apply(taskStart("b", "step b", "build"));
    painter.apply(detail("a", "a-line-1"));
    painter.apply(detail("b", "b-line-1"));
    painter.apply(detail("a", "a-line-2"));
    const joined = painter.snapshot().frameLines.join("\n");
    expect(joined).toContain("a-line-2");
    expect(joined).toContain("b-line-1");
    expect(painter.snapshot().activeTaskIds.length).toBe(2);
  });

  test("tree.complete collapses to a passive summary line", () => {
    const painter = new TaskTreeViewModel();
    painter.apply(treeStart("build", "Building", ["a", "b"]));
    painter.apply(taskStart("a", "step a", "build"));
    painter.apply(taskStart("b", "step b", "build"));
    painter.apply(detail("a", "x"));
    painter.apply(taskComplete("a", "step a", 10));
    painter.apply(taskComplete("b", "step b", 12));
    painter.apply(treeComplete("build", "Built app dependencies", 2, 0, 12400));
    const joined = painter.snapshot().frameLines.join("\n");
    expect(joined).toContain("2 ✓");
    expect(joined).toContain("0 ✗");
    expect(joined).toContain("(12.4s)");
    expect(painter.snapshot().frameLines[0]).toContain("(12.4s)");
    expect(painter.snapshot().activeTaskIds.length).toBe(0);
  });

  test("tree.complete hides pending placeholders for children that never started", () => {
    const painter = new TaskTreeViewModel();
    painter.apply(treeStart("build", "Building", ["a", "b"]));
    painter.apply(taskStart("a", "step a", "build"));
    painter.apply(taskFail("a", "step a failed", 1));
    painter.apply(treeComplete("build", "Build failed", 0, 1, 50));
    const frame = painter.snapshot().frameLines;
    expect(frame.join("\n")).toContain("[BLOCKED] Build failed");
    expect(frame.join("\n")).toContain("[BLOCKED] ✗ step a failed");
    expect(frame.join("\n")).not.toContain("[WAIT]");
    expect(new Set(frame.map((line) => line.length)).size).toBe(1);
  });
});

describe("TaskTreeViewModel — cached/skipped badges", () => {
  const completeWith = (summary: string, durationMs = 12400): string => {
    const painter = new TaskTreeViewModel();
    painter.apply(treeStart("build", "Building", ["a"]));
    painter.apply(taskStart("a", "step a", "build"));
    painter.apply(taskComplete("a", summary, durationMs));
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
    const painter = new TaskTreeViewModel();
    painter.apply(treeStart("build", "Building", ["cache"]));
    painter.apply(taskStart("cache", "cache", "build"));
    painter.apply(taskComplete("cache", "cache", 500));
    const frame = painter.snapshot().frameLines.join("\n");
    expect(frame).toContain("[ONLINE] ✓ cache");
    expect(frame).not.toContain("[CACHED]");
  });

  test("falls back to the task label when stripping the marker empties the summary", () => {
    const painter = new TaskTreeViewModel();
    painter.apply(treeStart("build", "Building", ["a"]));
    painter.apply(taskStart("a", "warm step", "build"));
    painter.apply(taskComplete("a", "(cached)", 100));
    const frame = painter.snapshot().frameLines.join("\n");
    expect(frame).toContain("[CACHED] ✓ warm step");
  });

  test("cached and skipped rows are color-accented in TTY but never status-by-color-only", () => {
    const painter = new TaskTreeViewModel();
    painter.apply(treeStart("build", "Building", ["a", "b"]));
    painter.apply(taskStart("a", "a", "build"));
    painter.apply(taskStart("b", "b", "build"));
    painter.apply(taskComplete("a", "a (cached)", 10));
    const cachedFrame = painter.frameLines().join("\n");
    painter.apply(taskComplete("b", "b (skipped)", 10));
    const skippedFrame = painter.frameLines().join("\n");
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

  test("non-TTY IO falls back to one plain line per renderable event", async () => {
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
    expect(io.stdoutLines()).toHaveLength(events.length);
    expect(out).toContain("[a] start");
    expect(out).toContain("[a] hello");
  });

  test("buffered TTY degrades to line mode without the native substrate", async () => {
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
    expect(stripCsi(out)).toContain("[a] hello");
    expect(buffered.stdoutLines()).toHaveLength(events.length);
  });
});
