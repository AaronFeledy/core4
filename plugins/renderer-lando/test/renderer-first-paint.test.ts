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
  CliCommandInitEvent,
  CliCommandRunEvent,
  type LandoEvent,
  TaskCompleteEvent,
  TaskStartEvent,
  TaskTreeCompleteEvent,
  TaskTreeStartEvent,
} from "@lando/sdk/events";
import { EventService } from "@lando/sdk/services";

import { EventServiceLive, type RendererIO, createBufferedRendererIO } from "@lando/core/testing";

import { renderPlainLine } from "../src/format.ts";
import { makeLandoEventConsumer } from "../src/renderer-runtime.ts";
import { TaskTreeViewModel } from "../src/task-tree-tail.ts";
import { createTestLiveRegionController, makeLiveRegionFixture } from "./live-region-test-kit.ts";

const ts = "2026-05-19T12:00:00.000Z";

const ESC = String.fromCharCode(27);
const ansiPattern = new RegExp(`${ESC}\\[[0-9;]*[A-Za-z]`, "g");
const stripAnsi = (text: string): string => text.replace(ansiPattern, "");
const placeholderLabel = (line: string): string => /◌\s+(\S+)/.exec(line)?.[1] ?? "";
const written = (fixture: ReturnType<typeof makeLiveRegionFixture>): string => fixture.writes.join("");

const cliInit = (commandId: string, invocationId: string, parentInvocationId?: string): LandoEvent =>
  Schema.decodeUnknownSync(CliCommandInitEvent)({
    _tag: `cli-${commandId}-init`,
    commandId,
    argv: [commandId],
    args: {},
    flags: {},
    cwd: "/tmp",
    invocationId,
    ...(parentInvocationId === undefined ? {} : { parentInvocationId }),
    timestamp: ts,
  });

const cliRun = (commandId: string, invocationId: string): LandoEvent =>
  Schema.decodeUnknownSync(CliCommandRunEvent)({
    _tag: `cli-${commandId}-run`,
    commandId,
    argv: [commandId],
    args: {},
    flags: {},
    cwd: "/tmp",
    invocationId,
    timestamp: ts,
    exitCode: 0,
    durationMs: 10,
  });

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
    expect(frame[0]).toBe("╭─ Building");
    expect(frame.at(-1)).toBe("╰─ 0/3 running");
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
    expect(frame.at(-1)).toBe("╰─ 0/2 running");
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
    expect(frame.at(-1)).toBe("╰─ 0/3 running");
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
    expect(frame.at(-1)).toBe("╰─ 0/0 running");
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
    const layer = Layer.provideMerge(makeLandoEventConsumer(recorder.io), EventServiceLive);
    await Effect.runPromise(Effect.scoped(drive([event]).pipe(Effect.provide(layer))));
    expect(recorder.chunks).toHaveLength(1);
    expect(recorder.chunks[0]).toBe(`${renderPlainLine(event)}\n`);
  });

  test("buffered degradation writes one complete plain line per event", async () => {
    const recorder = createFakeTerminalRecorder();
    const events = [treeStart("app", "Starting app", ["web"]), taskStart("web", "web", "app")];
    const layer = Layer.provideMerge(makeLandoEventConsumer(recorder.io), EventServiceLive);
    await Effect.runPromise(Effect.scoped(drive(events).pipe(Effect.provide(layer))));
    expect(recorder.chunks).toEqual(events.map((event) => `${renderPlainLine(event)}\n`));
  });
});

describe("first paint via the production TTY consumer and fake OpenTUI substrate", () => {
  test("publishes the live skeleton before completion, then commits and releases the finished tree", async () => {
    const fixture = makeLiveRegionFixture();
    const base = createBufferedRendererIO({ isTTY: true, terminalColumns: 80, terminalRows: 24 });
    const io = { ...base, externalOutputStream: process.stdout };

    const firstPaint = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const events = yield* EventService;
          yield* events.publish(treeStart("app", "Starting app", ["web", "db"]));
          yield* events.publish(taskStart("web", "web service", "app"));
          yield* waitForConsumer(
            () => written(fixture).includes("web service") && written(fixture).includes("◌ db"),
          );
          const beforeCompletion = written(fixture);
          const firstWrite = fixture.writes[0] ?? "";
          yield* events.publish(taskComplete("web"));
          yield* events.publish(treeComplete("app", "Built app"));
          yield* waitForConsumer(() => written(fixture).includes("Built app"));
          return { beforeCompletion, firstWrite };
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

    expect(stripAnsi(firstPaint.beforeCompletion)).toContain("╰─ 1/2 running");
    expect(firstPaint.beforeCompletion).toContain("web service");
    expect(firstPaint.beforeCompletion).toContain("◌ db");
    expect(firstPaint.beforeCompletion).not.toContain("Built app");
    expect(firstPaint.firstWrite).not.toMatch(new RegExp(`${ESC}\\[[0-9;]*(?:A|J)`, "u"));
    expect(written(fixture)).toContain("Built app");
  });
});

describe("provisional first paint via the production TTY consumer", () => {
  const ttyIo = () => {
    const base = createBufferedRendererIO({ isTTY: true, terminalColumns: 80, terminalRows: 24 });
    return { ...base, externalOutputStream: process.stdout };
  };

  test("allowlisted outer init acquires the live region and paints a title-only footer before any tree", async () => {
    const cases = [
      ["app:start", "╭─ start"],
      ["app:restart", "╭─ restart"],
      ["app:rebuild", "╭─ rebuild"],
    ] as const;
    for (const [commandId, title] of cases) {
      const fixture = makeLiveRegionFixture();
      let acquisitions = 0;
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const events = yield* EventService;
            yield* events.publish(cliInit(commandId, `inv-${commandId}`));
            yield* waitForConsumer(() => stripAnsi(written(fixture)).includes(title));
          }).pipe(
            Effect.provide(
              Layer.provideMerge(
                makeLandoEventConsumer(ttyIo(), {
                  createLiveRegion: (options) => {
                    acquisitions += 1;
                    return createTestLiveRegionController(fixture, options);
                  },
                }),
                EventServiceLive,
              ),
            ),
          ),
        ),
      );
      expect(acquisitions).toBe(1);
      const first = stripAnsi(written(fixture));
      expect(first).toContain(title);
      expect(first).not.toContain("╰─");
      expect(fixture.commits).toEqual([]);
    }
  });

  test("task.tree.start replaces the same footer and does not commit the provisional title", async () => {
    const fixture = makeLiveRegionFixture();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const events = yield* EventService;
          yield* events.publish(cliInit("app:start", "inv-1"));
          yield* waitForConsumer(() => stripAnsi(written(fixture)).includes("╭─ start"));
          yield* events.publish(treeStart("app", "Starting app", ["web", "db"]));
          yield* events.publish(taskStart("web", "web service", "app"));
          yield* waitForConsumer(
            () => written(fixture).includes("web service") && written(fixture).includes("◌ db"),
          );
        }).pipe(
          Effect.provide(
            Layer.provideMerge(
              makeLandoEventConsumer(ttyIo(), {
                createLiveRegion: (options) => createTestLiveRegionController(fixture, options),
              }),
              EventServiceLive,
            ),
          ),
        ),
      ),
    );
    const text = stripAnsi(written(fixture));
    expect(text).toContain("╭─ start");
    expect(text).toContain("web service");
    expect(fixture.commits).toEqual([]);
  });

  test("matching terminal without a tree clears the footer without scrollback", async () => {
    const fixture = makeLiveRegionFixture();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const events = yield* EventService;
          yield* events.publish(cliInit("app:start", "inv-1"));
          yield* waitForConsumer(() => stripAnsi(written(fixture)).includes("╭─ start"));
          yield* events.publish(cliRun("app:start", "inv-1"));
          yield* waitForConsumer(() => fixture.writes.length > 0);
        }).pipe(
          Effect.provide(
            Layer.provideMerge(
              makeLandoEventConsumer(ttyIo(), {
                createLiveRegion: (options) => createTestLiveRegionController(fixture, options),
              }),
              EventServiceLive,
            ),
          ),
        ),
      ),
    );
    expect(stripAnsi(written(fixture))).toContain("╭─ start");
    expect(fixture.commits).toEqual([]);
  });

  test("prompt-first and nested inits do not acquire or paint", async () => {
    const fixture = makeLiveRegionFixture();
    let acquisitions = 0;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const events = yield* EventService;
          for (const event of [
            cliInit("apps:init", "inv-1"),
            cliInit("meta:setup", "inv-2"),
            cliInit("app:destroy", "inv-3"),
            cliInit("mysql", "inv-4"),
            cliInit("app:start", "inv-6", "inv-5"),
          ]) {
            yield* events.publish(event);
          }
          yield* Effect.sleep("20 millis");
        }).pipe(
          Effect.provide(
            Layer.provideMerge(
              makeLandoEventConsumer(ttyIo(), {
                createLiveRegion: (options) => {
                  acquisitions += 1;
                  return createTestLiveRegionController(fixture, options);
                },
              }),
              EventServiceLive,
            ),
          ),
        ),
      ),
    );
    expect(acquisitions).toBe(0);
    expect(fixture.writes).toEqual([]);
  });
});
