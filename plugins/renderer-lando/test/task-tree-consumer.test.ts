/**
 * Default TTY consumer wiring — split-footer live region vs line-mode degradation.
 *
 * These host tests drive the event consumer against a recording fake live-region
 * controller (no native OpenTUI binding). They prove the routing/ordering, the
 * tree-complete scrollback commit, dispose-on-scope-close, and the two
 * degradation fallbacks. Native split-footer behavior (AC3 resize replay, AC4
 * alt-screen) is validated in the Wave 5 sandbox headless suite.
 */

import { describe, expect, test } from "bun:test";
import { Effect, Layer, Schema } from "effect";

import {
  type LandoEvent,
  MessageWarnEvent,
  TaskCompleteEvent,
  TaskStartEvent,
  TaskTreeCompleteEvent,
  TaskTreeStartEvent,
} from "@lando/sdk/events";
import { EventService } from "@lando/sdk/services";

import { createBufferedRendererIO } from "../../../core/src/cli/renderer/io.ts";
import { EventServiceLive } from "../../../core/src/services/event-service.ts";
import type { LiveRegionControllerOptions } from "../src/opentui/live-region-controller.ts";
import { makeLandoEventConsumer } from "../src/renderer-runtime.ts";

const ts = "2026-05-19T12:00:00.000Z";

const treeStart = (children: ReadonlyArray<string>): LandoEvent =>
  Schema.decodeUnknownSync(TaskTreeStartEvent)({
    _tag: "task.tree.start",
    parentId: "build",
    label: "Building",
    children,
    timestamp: ts,
  });
const taskStart = (taskId: string): LandoEvent =>
  Schema.decodeUnknownSync(TaskStartEvent)({ _tag: "task.start", taskId, label: taskId, timestamp: ts });
const taskComplete = (taskId: string): LandoEvent =>
  Schema.decodeUnknownSync(TaskCompleteEvent)({
    _tag: "task.complete",
    taskId,
    summary: `${taskId} ready`,
    durationMs: 10,
    timestamp: ts,
  });
const treeComplete = (): LandoEvent =>
  Schema.decodeUnknownSync(TaskTreeCompleteEvent)({
    _tag: "task.tree.complete",
    parentId: "build",
    summary: "done",
    succeeded: 1,
    failed: 0,
    timestamp: ts,
  });
const warn = (body: string): LandoEvent =>
  Schema.decodeUnknownSync(MessageWarnEvent)({ _tag: "message.warn", body, timestamp: ts });

type ControllerCall =
  | { readonly kind: "setFooter"; readonly lines: ReadonlyArray<string> }
  | { readonly kind: "commitScrollback"; readonly text: string }
  | { readonly kind: "requestLive" }
  | { readonly kind: "dropLive" }
  | { readonly kind: "enterFullTail" }
  | { readonly kind: "exitFullTail" }
  | { readonly kind: "dispose" };

class FakeController {
  readonly calls: ControllerCall[] = [];
  setFooter(lines: ReadonlyArray<string>): void {
    this.calls.push({ kind: "setFooter", lines: [...lines] });
  }
  commitScrollback(text: string): void {
    this.calls.push({ kind: "commitScrollback", text });
  }
  requestLive(): void {
    this.calls.push({ kind: "requestLive" });
  }
  dropLive(): void {
    this.calls.push({ kind: "dropLive" });
  }
  resize(): void {}
  enterFullTail(): void {
    this.calls.push({ kind: "enterFullTail" });
  }
  exitFullTail(): void {
    this.calls.push({ kind: "exitFullTail" });
  }
  reset(): void {}
  dispose(): void {
    this.calls.push({ kind: "dispose" });
  }
}

const ttyIo = () => {
  const stdout: string[] = [];
  const io = createBufferedRendererIO({ isTTY: true, terminalColumns: 80, terminalRows: 24 });
  const streamStub = { write: () => true } as unknown as NodeJS.WriteStream;
  return {
    io: { ...io, externalOutputStream: streamStub, writeStdout: (chunk: string) => stdout.push(chunk) },
    stdout: () => stdout.join(""),
  };
};

const drive = (
  io: ReturnType<typeof ttyIo>["io"],
  createLiveRegion: (options: LiveRegionControllerOptions) => Promise<FakeController>,
  events: ReadonlyArray<LandoEvent>,
): Effect.Effect<void> =>
  Effect.scoped(
    Effect.gen(function* () {
      const svc = yield* EventService;
      for (const event of events) yield* svc.publish(event);
      yield* Effect.sleep("20 millis");
    }).pipe(
      Effect.provide(Layer.provideMerge(makeLandoEventConsumer(io, { createLiveRegion }), EventServiceLive)),
    ),
  );

describe("makeLandoEventConsumer — split-footer substrate routing", () => {
  test("task events update the footer; message.* commits to scrollback", async () => {
    const { io } = ttyIo();
    const controller = new FakeController();
    await Effect.runPromise(
      drive(io, () => Promise.resolve(controller), [treeStart(["web"]), taskStart("web"), warn("heads up")]),
    );
    const setFooters = controller.calls.filter((c) => c.kind === "setFooter");
    expect(setFooters.length).toBeGreaterThan(0);
    expect(setFooters.at(-1)?.kind === "setFooter" && setFooters.at(-1)?.lines.join("\n")).toContain("web");
    const commits = controller.calls.filter((c) => c.kind === "commitScrollback");
    expect(commits.some((c) => c.kind === "commitScrollback" && c.text.includes("heads up"))).toBe(true);
  });

  test("tree.complete commits the summary to scrollback and retires the live footer", async () => {
    const { io } = ttyIo();
    const controller = new FakeController();
    await Effect.runPromise(
      drive(io, () => Promise.resolve(controller), [
        treeStart(["web"]),
        taskStart("web"),
        taskComplete("web"),
        treeComplete(),
      ]),
    );
    const commits = controller.calls.filter((c) => c.kind === "commitScrollback");
    expect(commits.some((c) => c.kind === "commitScrollback" && c.text.includes("done"))).toBe(true);
    const lastFooter = [...controller.calls].reverse().find((c) => c.kind === "setFooter");
    expect(lastFooter?.kind === "setFooter" && lastFooter.lines.length).toBe(0);
  });

  test("the controller is disposed exactly once when the consumer scope closes", async () => {
    const { io } = ttyIo();
    const controller = new FakeController();
    await Effect.runPromise(
      drive(io, () => Promise.resolve(controller), [treeStart(["web"]), taskStart("web")]),
    );
    expect(controller.calls.filter((c) => c.kind === "dispose")).toHaveLength(1);
  });
});

describe("makeLandoEventConsumer — degradation to line mode", () => {
  test("a TTY IO without externalOutputStream never constructs the controller and writes line output", async () => {
    const stdout: string[] = [];
    const base = createBufferedRendererIO({ isTTY: true, terminalColumns: 80 });
    const io = { ...base, writeStdout: (chunk: string) => stdout.push(chunk) };
    let created = false;
    await Effect.runPromise(
      drive(
        io,
        () => {
          created = true;
          return Promise.resolve(new FakeController());
        },
        [treeStart(["web"]), taskStart("web")],
      ),
    );
    expect(created).toBe(false);
    expect(stdout.join("")).toContain("web");
  });

  test("a controller load failure falls back to line output without crashing", async () => {
    const { io, stdout } = ttyIo();
    await Effect.runPromise(
      drive(io, () => Promise.reject(new Error("no native binding")), [treeStart(["web"]), taskStart("web")]),
    );
    expect(stdout()).toContain("web");
  });
});
