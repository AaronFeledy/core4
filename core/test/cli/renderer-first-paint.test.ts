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

import {
  type LandoEvent,
  TaskCompleteEvent,
  TaskStartEvent,
  TaskTreeCompleteEvent,
  TaskTreeStartEvent,
} from "@lando/sdk/events";
import { EventService } from "@lando/sdk/services";

import { makeLandoEventConsumer } from "../../../plugins/renderer-lando/src/renderer-runtime.ts";
import { landoRenderer } from "../../src/cli/renderer/bundled-renderers.ts";
import { renderPlainLine } from "../../src/cli/renderer/format.ts";
import { type RendererIO, createBufferedRendererIO } from "../../src/cli/renderer/io.ts";
import { TaskTreeViewModel } from "../../src/cli/renderer/task-tree-tail.ts";
import { EventServiceLive } from "../../src/services/event-service.ts";
import { createTestLiveRegionController, makeLiveRegionFixture } from "./renderer-live-region-test-kit.ts";

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

const taskComplete = (taskId: string): LandoEvent =>
  Schema.decodeUnknownSync(TaskCompleteEvent)({
    _tag: "task.complete",
    taskId,
    summary: `${taskId} ready`,
    durationMs: 10,
    timestamp: ts,
  });

const treeComplete = (parentId: string, summary: string): LandoEvent =>
  Schema.decodeUnknownSync(TaskTreeCompleteEvent)({
    _tag: "task.tree.complete",
    parentId,
    summary,
    succeeded: 1,
    failed: 0,
    timestamp: ts,
  });

const waitForConsumer = (condition: () => boolean): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      if (condition()) return;
      yield* Effect.yieldNow();
    }
    return yield* Effect.fail(new Error("Renderer consumer did not reach the expected ordering point."));
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

describe("first paint via the production TTY consumer and fake OpenTUI substrate", () => {
  test("publishes the live skeleton before completion, then commits and releases the finished tree", async () => {
    // Given
    const fixture = makeLiveRegionFixture();
    const base = createBufferedRendererIO({ isTTY: true, terminalColumns: 80, terminalRows: 24 });
    const io = { ...base, externalOutputStream: process.stdout };

    // When
    const firstPaintCalls = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const events = yield* EventService;
          yield* events.publish(treeStart("app", "Starting app", ["web", "db"]));
          yield* events.publish(taskStart("web", "web service", "app"));
          yield* waitForConsumer(() =>
            fixture.calls.some(
              (call) => call.startsWith("footer:") && call.includes("web service") && call.includes("◌ db"),
            ),
          );
          const callsBeforeCompletion = [...fixture.calls];
          yield* events.publish(taskComplete("web"));
          yield* events.publish(treeComplete("app", "Built app"));
          yield* waitForConsumer(
            () =>
              fixture.calls.some((call) => call.startsWith("scrollback:") && call.includes("Built app")) &&
              fixture.calls.includes("screenMode:main-screen"),
          );
          return callsBeforeCompletion;
        }).pipe(
          Effect.provide(
            Layer.provideMerge(
              makeLandoEventConsumer(io, {
                createLiveRegion: (options) => createTestLiveRegionController(fixture, options),
              }),
              EventServiceLive,
            ),
          ),
        ),
      ),
    );

    // Then
    const firstFooter = firstPaintCalls.find(
      (call) => call.startsWith("footer:") && call.includes("web service"),
    );
    expect(firstFooter).toContain("Starting app (1/2 running)");
    expect(firstFooter).toContain("web service");
    expect(firstFooter).toContain("◌ db");
    expect(firstPaintCalls.some((call) => call.startsWith("scrollback:"))).toBe(false);
    expect(firstPaintCalls.join("\n")).not.toMatch(
      new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*(?:A|J)`, "u"),
    );
    expect(fixture.commits.some((text) => text.includes("Built app"))).toBe(true);
    expect(fixture.calls).toContain("screenMode:main-screen");
  });
});
