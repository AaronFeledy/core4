/**
 * First-paint contract for the default Lando TTY renderer.
 *
 * The renderer must initialize the concurrent task-tree skeleton — the parent
 * line plus one pending placeholder per declared child — on `task.tree.start`,
 * *before* any child `task.start` work runs. The first paint is plain text
 * (no control sequences) and is asserted byte-for-byte through a fake terminal
 * recorder that captures every write chunk.
 */

import { describe, expect, test } from "bun:test";
import { Effect, Layer, Schema } from "effect";

import { type LandoEvent, TaskStartEvent, TaskTreeStartEvent } from "@lando/sdk/events";
import { EventService } from "@lando/sdk/services";

import type { RendererIO } from "../../src/cli/renderer/io.ts";
import { makeLandoRendererLive } from "../../src/cli/renderer/runtime.ts";
import { LandoTreePainter, csi } from "../../src/cli/renderer/task-tree-tail.ts";
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

/**
 * Minimal fake terminal that records every write chunk in arrival order so the
 * first-paint bytes can be asserted exactly.
 */
interface FakeTerminalRecorder {
  readonly io: RendererIO;
  readonly chunks: ReadonlyArray<string>;
  output: () => string;
}

const createFakeTerminalRecorder = (
  options: { readonly terminalColumns?: number; readonly terminalRows?: number } = {},
): FakeTerminalRecorder => {
  const chunks: string[] = [];
  const io: RendererIO = {
    writeStdout: (chunk) => {
      chunks.push(chunk);
    },
    writeStderr: () => {},
    isTTY: true,
    terminalColumns: options.terminalColumns ?? 80,
    terminalRows: options.terminalRows,
  };
  return {
    io,
    chunks,
    output: () => chunks.join(""),
  };
};

describe("LandoTreePainter — first-paint skeleton", () => {
  test("paints the parent line plus one pending placeholder per declared child, byte-for-byte", () => {
    const painter = new LandoTreePainter();
    const firstPaint = painter.consume(treeStart("build", "Building", ["web", "db", "cache"]));
    expect(firstPaint).toBe("▼ Building (0/3 running)\n  ◌ web\n  ◌ db\n  ◌ cache\n");
  });

  test("deduplicates declared children before counting and painting placeholders", () => {
    const painter = new LandoTreePainter();
    const firstPaint = painter.consume(treeStart("build", "Building", ["web", "db", "web"]));
    expect(firstPaint).toBe("▼ Building (0/2 running)\n  ◌ web\n  ◌ db\n");
  });

  test("first paint emits no control sequences (skeleton is plain text)", () => {
    const painter = new LandoTreePainter();
    const firstPaint = painter.consume(treeStart("build", "Building", ["a", "b"]));
    const ESC = String.fromCharCode(27);
    expect(firstPaint.includes(`${ESC}[`)).toBe(false);
  });

  test("skeleton renders before any work: no running marker, no detail panel on first paint", () => {
    const painter = new LandoTreePainter();
    painter.consume(treeStart("build", "Building", ["a", "b", "c"]));
    const frame = painter.snapshot().frameLines;
    expect(frame).toEqual(["▼ Building (0/3 running)", "  ◌ a", "  ◌ b", "  ◌ c"]);
    expect(frame.some((line) => line.includes("·"))).toBe(false);
    expect(frame.some((line) => /^\s{4,}/.test(line))).toBe(false);
    expect(painter.snapshot().activeTaskIds).toEqual([]);
  });

  test("a child's task.start transitions its placeholder to running; siblings stay pending", () => {
    const painter = new LandoTreePainter();
    painter.consume(treeStart("build", "Building", ["web", "db", "cache"]));
    painter.consume(taskStart("web", "web service", "build"));
    const frame = painter.snapshot().frameLines;
    const joined = frame.join("\n");
    expect(joined).toContain("· web service");
    expect(joined).toContain("◌ db");
    expect(joined).toContain("◌ cache");
    expect(joined).not.toContain("◌ web");
    expect(painter.snapshot().activeTaskIds).toEqual(["web"]);
  });

  test("pending placeholders preserve declared child order", () => {
    const painter = new LandoTreePainter();
    painter.consume(treeStart("build", "Building", ["z", "a", "m"]));
    const frame = painter.snapshot().frameLines;
    expect(frame).toEqual(["▼ Building (0/3 running)", "  ◌ z", "  ◌ a", "  ◌ m"]);
  });

  test("pending placeholders are not focus targets (focus lands on started tasks only)", () => {
    const painter = new LandoTreePainter();
    painter.consume(treeStart("build", "Building", ["a", "b", "c"]));
    expect(painter.focusableTaskIds()).toEqual([]);
    expect(painter.canExpandTask("a")).toBe(false);
    painter.consume(taskStart("b", "step b", "build"));
    expect(painter.focusableTaskIds()).toEqual(["b"]);
  });

  test("empty declared children paint just the parent skeleton line", () => {
    const painter = new LandoTreePainter();
    const firstPaint = painter.consume(treeStart("build", "Building", []));
    expect(firstPaint).toBe("▼ Building (0/0 running)\n");
  });
});

describe("first paint via fake terminal recorder (Live TTY renderer)", () => {
  const drive = (events: ReadonlyArray<LandoEvent>) =>
    Effect.gen(function* () {
      const svc = yield* EventService;
      for (const event of events) yield* svc.publish(event);
      yield* Effect.sleep("20 millis");
    });

  test("the first recorded write is the byte-for-byte task-tree skeleton", async () => {
    const recorder = createFakeTerminalRecorder();
    const layer = Layer.provideMerge(makeLandoRendererLive(recorder.io), EventServiceLive);
    await Effect.runPromise(
      Effect.scoped(drive([treeStart("app", "Starting app", ["web", "db"])]).pipe(Effect.provide(layer))),
    );
    expect(recorder.chunks.length).toBeGreaterThanOrEqual(1);
    expect(recorder.chunks[0]).toBe("▼ Starting app (0/2 running)\n  ◌ web\n  ◌ db\n");
  });

  test("the first recorded write contains no cursor-up / erase control bytes", async () => {
    const recorder = createFakeTerminalRecorder();
    const layer = Layer.provideMerge(makeLandoRendererLive(recorder.io), EventServiceLive);
    await Effect.runPromise(
      Effect.scoped(drive([treeStart("app", "Starting app", ["web"])]).pipe(Effect.provide(layer))),
    );
    const firstChunk = recorder.chunks[0] ?? "";
    expect(firstChunk.includes(csi.eraseDown)).toBe(false);
    expect(firstChunk.includes(csi.cursorUp(1).slice(0, 2))).toBe(false);
  });
});
