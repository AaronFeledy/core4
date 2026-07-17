/**
 * First-paint contract for the default Lando task-tree view model.
 *
 * The renderer must initialize the concurrent task-tree skeleton — the parent
 * line plus one pending placeholder per declared child — on `task.tree.start`,
 * *before* any child `task.start` work runs. Pure frame content and buffered
 * line-mode degradation are covered independently.
 */

import { describe, expect, test } from "bun:test";
import { Effect, Layer, Schema } from "effect";

import { type LandoEvent, TaskStartEvent, TaskTreeStartEvent } from "@lando/sdk/events";
import { EventService } from "@lando/sdk/services";

import { landoRenderer } from "../../src/cli/renderer/bundled-renderers.ts";
import { renderPlainLine } from "../../src/cli/renderer/format.ts";
import type { RendererIO } from "../../src/cli/renderer/io.ts";
import { TaskTreeViewModel } from "../../src/cli/renderer/task-tree-tail.ts";
import { EventServiceLive } from "../../src/services/event-service.ts";

const ts = "2026-05-19T12:00:00.000Z";

const ESC = String.fromCharCode(27);
const ansiPattern = new RegExp(`${ESC}\\[[0-9;]*[A-Za-z]`, "g");
const stripAnsi = (text: string): string => text.replace(ansiPattern, "");
const placeholderLabel = (line: string): string => /◌\s+(\S+)/.exec(line)?.[1] ?? "";

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
 * Minimal buffered terminal that records every write chunk in arrival order.
 */
interface FakeTerminalRecorder {
  readonly io: RendererIO;
  readonly chunks: ReadonlyArray<string>;
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
    terminalColumns: options.terminalColumns ?? 80,
    terminalRows: options.terminalRows,
  };
  return {
    io,
    chunks,
  };
};

describe("TaskTreeViewModel — first-paint skeleton", () => {
  test("paints the parent line plus one pending placeholder per declared child", () => {
    const vm = new TaskTreeViewModel();
    vm.apply(treeStart("build", "Building", ["web", "db", "cache"]));
    const frame = vm.snapshot().frameLines.map(stripAnsi);
    expect(frame[0]).toContain("LANDO OPS");
    expect(frame[0]).toContain("Building (0/3 running)");
    const placeholders = frame.filter((line) => line.includes("◌"));
    expect(placeholders).toHaveLength(3);
    expect(placeholders[0]).toContain("◌ web");
    expect(placeholders[1]).toContain("◌ db");
    expect(placeholders[2]).toContain("◌ cache");
  });

  test("deduplicates declared children before counting and painting placeholders", () => {
    const vm = new TaskTreeViewModel();
    vm.apply(treeStart("build", "Building", ["web", "db", "web"]));
    const frame = vm.snapshot().frameLines.map(stripAnsi);
    expect(frame[0]).toContain("Building (0/2 running)");
    const placeholders = frame.filter((line) => line.includes("◌"));
    expect(placeholders).toHaveLength(2);
    expect(placeholders[0]).toContain("◌ web");
    expect(placeholders[1]).toContain("◌ db");
  });

  test("first paint exposes styled content lines matching the logical skeleton", () => {
    const vm = new TaskTreeViewModel();
    vm.apply(treeStart("build", "Building", ["a", "b"]));
    expect(vm.frameLines().map(stripAnsi).join("\n")).toBe(vm.snapshot().frameLines.join("\n"));
    expect(vm.snapshot().frameLines).toHaveLength(4);
  });

  test("skeleton renders before any work: no running marker, no detail panel on first paint", () => {
    const vm = new TaskTreeViewModel();
    vm.apply(treeStart("build", "Building", ["a", "b", "c"]));
    const frame = vm.snapshot().frameLines.map(stripAnsi);
    expect(frame[0]).toContain("Building (0/3 running)");
    const placeholders = frame.filter((line) => line.includes("◌"));
    expect(placeholders.map(placeholderLabel)).toEqual(["a", "b", "c"]);
    expect(frame.some((line) => line.includes("· "))).toBe(false);
    expect(vm.snapshot().activeTaskIds).toEqual([]);
  });

  test("a child's task.start transitions its placeholder to running; siblings stay pending", () => {
    const vm = new TaskTreeViewModel();
    vm.apply(treeStart("build", "Building", ["web", "db", "cache"]));
    vm.apply(taskStart("web", "web service", "build"));
    const frame = vm.snapshot().frameLines;
    const joined = frame.join("\n");
    expect(joined).toContain("· web service");
    expect(joined).toContain("◌ db");
    expect(joined).toContain("◌ cache");
    expect(joined).not.toContain("◌ web");
    expect(vm.snapshot().activeTaskIds).toEqual(["web"]);
  });

  test("pending placeholders preserve declared child order", () => {
    const vm = new TaskTreeViewModel();
    vm.apply(treeStart("build", "Building", ["z", "a", "m"]));
    const frame = vm.snapshot().frameLines.map(stripAnsi);
    const placeholders = frame.filter((line) => line.includes("◌"));
    expect(placeholders.map(placeholderLabel)).toEqual(["z", "a", "m"]);
  });

  test("pending placeholders are not focus targets (focus lands on started tasks only)", () => {
    const vm = new TaskTreeViewModel();
    vm.apply(treeStart("build", "Building", ["a", "b", "c"]));
    expect(vm.focusableTaskIds()).toEqual([]);
    expect(vm.canExpandTask("a")).toBe(false);
    vm.apply(taskStart("b", "step b", "build"));
    expect(vm.focusableTaskIds()).toEqual(["b"]);
  });

  test("empty declared children paint just the parent skeleton line", () => {
    const vm = new TaskTreeViewModel();
    vm.apply(treeStart("build", "Building", []));
    const frame = vm.snapshot().frameLines.map(stripAnsi);
    expect(frame[0]).toContain("Building (0/0 running)");
    expect(frame.some((line) => line.includes("◌"))).toBe(false);
  });
});

describe("first paint via fake terminal recorder (buffered degradation)", () => {
  const drive = (events: ReadonlyArray<LandoEvent>) =>
    Effect.gen(function* () {
      const svc = yield* EventService;
      for (const event of events) yield* svc.publish(event);
      yield* Effect.sleep("20 millis");
    });

  test("the first recorded write is the plain task-tree start line", async () => {
    const recorder = createFakeTerminalRecorder();
    const event = treeStart("app", "Starting app", ["web", "db"]);
    const layer = Layer.provideMerge(landoRenderer.makeEventConsumer(recorder.io), EventServiceLive);
    await Effect.runPromise(Effect.scoped(drive([event]).pipe(Effect.provide(layer))));
    expect(recorder.chunks).toHaveLength(1);
    expect(recorder.chunks[0]).toBe(`${renderPlainLine(event)}\n`);
  });

  test("buffered degradation writes one complete plain line per event", async () => {
    const recorder = createFakeTerminalRecorder();
    const events = [treeStart("app", "Starting app", ["web"]), taskStart("web", "web", "app")];
    const layer = Layer.provideMerge(landoRenderer.makeEventConsumer(recorder.io), EventServiceLive);
    await Effect.runPromise(Effect.scoped(drive(events).pipe(Effect.provide(layer))));
    expect(recorder.chunks).toEqual(events.map((event) => `${renderPlainLine(event)}\n`));
  });
});
