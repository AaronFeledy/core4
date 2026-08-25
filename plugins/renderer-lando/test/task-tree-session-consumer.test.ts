import { afterEach, describe, expect, test } from "bun:test";
import { Effect, Layer, Schema } from "effect";

import {
  CliCommandErrorEvent,
  CliCommandInitEvent,
  CliCommandRunEvent,
  type LandoEvent,
  MessageWarnEvent,
  TaskCompleteEvent,
  TaskDetailExpandEvent,
  TaskStartEvent,
  TaskTreeCompleteEvent,
  TaskTreeStartEvent,
} from "@lando/sdk/events";
import type { RendererIO } from "@lando/sdk/renderer";
import { AbsolutePath } from "@lando/sdk/schema";
import { EventService } from "@lando/sdk/services";

import { EventServiceLive, createBufferedRendererIO } from "@lando/core/testing";

import type { LiveRegionControllerOptions } from "../src/opentui/live-region-controller.ts";
import { resetOpenTuiSubstrateAvailabilityForTests } from "../src/opentui/substrate-availability.ts";
import { makeLandoEventConsumer } from "../src/renderer-runtime.ts";

const ts = "2026-05-19T12:00:00.000Z";
const ESC = String.fromCharCode(27);
const stripAnsi = (text: string): string => text.replace(new RegExp(`${ESC}\\[[0-9;]*[A-Za-z]`, "g"), "");

const treeStart = (parentId: string, children: ReadonlyArray<string>, label = parentId): LandoEvent =>
  Schema.decodeUnknownSync(TaskTreeStartEvent)({
    _tag: "task.tree.start",
    parentId,
    label,
    children,
    timestamp: ts,
  });
const taskStart = (taskId: string, parentId: string, transcriptPath?: string): LandoEvent =>
  Schema.decodeUnknownSync(TaskStartEvent)({
    _tag: "task.start",
    taskId,
    label: taskId,
    parentId,
    ...(transcriptPath === undefined ? {} : { transcriptPath }),
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
    durationMs: 10,
    timestamp: ts,
  });
const warn = (body: string): LandoEvent =>
  Schema.decodeUnknownSync(MessageWarnEvent)({ _tag: "message.warn", body, timestamp: ts });

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
const cliRun = (commandId: string, invocationId: string, parentInvocationId?: string): LandoEvent =>
  Schema.decodeUnknownSync(CliCommandRunEvent)({
    _tag: `cli-${commandId}-run`,
    commandId,
    argv: [commandId],
    args: {},
    flags: {},
    cwd: "/tmp",
    invocationId,
    ...(parentInvocationId === undefined ? {} : { parentInvocationId }),
    timestamp: ts,
    exitCode: 0,
    durationMs: 20,
  });
const cliError = (commandId: string, invocationId: string): LandoEvent =>
  Schema.decodeUnknownSync(CliCommandErrorEvent)({
    _tag: `cli-${commandId}-error`,
    commandId,
    argv: [commandId],
    args: {},
    flags: {},
    cwd: "/tmp",
    invocationId,
    timestamp: ts,
    exitCode: 1,
    durationMs: 20,
    failureTag: "Failure",
  });

type ControllerCall =
  | { readonly kind: "setFooter"; readonly lines: ReadonlyArray<string> }
  | { readonly kind: "commitScrollback"; readonly text: string }
  | { readonly kind: "rememberScrollback"; readonly text: string }
  | { readonly kind: "requestLive" }
  | { readonly kind: "dropLive" }
  | { readonly kind: "enterFullTail" }
  | { readonly kind: "exitFullTail" }
  | { readonly kind: "dispose" };

class FakeTranscriptReader {
  readonly opened: string[] = [];
  readonly #lines = new Map<string, string[]>();
  set(path: string, lines: ReadonlyArray<string>): void {
    this.#lines.set(path, [...lines]);
  }
  open(path: string, _onChange: unknown) {
    return Effect.acquireRelease(
      Effect.sync(() => {
        this.opened.push(path);
        return {
          read: () => Effect.succeed({ lines: this.#lines.get(path) ?? [] }),
        };
      }),
      () => Effect.void,
    );
  }
}

class FakeController {
  readonly calls: ControllerCall[] = [];
  setFooter(lines: ReadonlyArray<string>): void {
    this.calls.push({ kind: "setFooter", lines: [...lines] });
  }
  commitScrollback(text: string): void {
    this.calls.push({ kind: "commitScrollback", text });
  }
  rememberScrollback(text: string): void {
    this.calls.push({ kind: "rememberScrollback", text });
  }
  requestLive(): void {
    this.calls.push({ kind: "requestLive" });
  }
  dropLive(): void {
    this.calls.push({ kind: "dropLive" });
  }
  enterFullTail(): void {
    this.calls.push({ kind: "enterFullTail" });
  }
  exitFullTail(): Promise<void> {
    this.calls.push({ kind: "exitFullTail" });
    return Promise.resolve();
  }
  dispose(): Promise<void> {
    this.calls.push({ kind: "dispose" });
    return Promise.resolve();
  }
}

const ttyIo = () => {
  const io = createBufferedRendererIO({ isTTY: true, terminalColumns: 80, terminalRows: 24 });
  return { io: { ...io, externalOutputStream: process.stdout } };
};

const drive = (
  io: RendererIO,
  createLiveRegion: (options: LiveRegionControllerOptions) => Promise<FakeController>,
  events: ReadonlyArray<LandoEvent>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const svc = yield* EventService;
      for (const event of events) yield* svc.publish(event);
      yield* Effect.sleep("20 millis");
    }).pipe(
      Effect.provide(Layer.provideMerge(makeLandoEventConsumer(io, { createLiveRegion }), EventServiceLive)),
    ),
  );

const committedText = (controller: FakeController): string =>
  controller.calls
    .filter((call) => call.kind === "commitScrollback")
    .map((call) => (call.kind === "commitScrollback" ? stripAnsi(call.text) : ""))
    .join("\n");

const footerTexts = (controller: FakeController): ReadonlyArray<string> =>
  controller.calls
    .filter((call) => call.kind === "setFooter")
    .map((call) => (call.kind === "setFooter" ? call.lines.map(stripAnsi).join("\n") : ""));

afterEach(() => {
  resetOpenTuiSubstrateAvailabilityForTests();
});

describe("lifecycle-backed task session", () => {
  test("non-allowlisted outer init arms without acquiring OpenTUI", async () => {
    const { io } = ttyIo();
    const controller = new FakeController();
    let acquisitions = 0;
    await Effect.runPromise(
      drive(
        io,
        () => {
          acquisitions += 1;
          return Promise.resolve(controller);
        },
        [cliInit("app:info", "inv-1")],
      ),
    );
    expect(acquisitions).toBe(0);
    expect(controller.calls).toEqual([]);
  });

  test("allowlisted outer init acquires and paints a title-only footer", async () => {
    const { io } = ttyIo();
    const controller = new FakeController();
    let acquisitions = 0;
    await Effect.runPromise(
      drive(
        io,
        () => {
          acquisitions += 1;
          return Promise.resolve(controller);
        },
        [cliInit("app:start", "inv-1")],
      ),
    );
    expect(acquisitions).toBe(1);
    expect(footerTexts(controller)[0]).toBe("╭─ start");
    expect(controller.calls.filter((call) => call.kind === "commitScrollback")).toEqual([]);
    expect(controller.calls.filter((call) => call.kind === "rememberScrollback")).toEqual([]);
  });

  test("task.tree.start replaces the provisional footer and does not commit it", async () => {
    const { io } = ttyIo();
    const controller = new FakeController();
    await Effect.runPromise(
      drive(io, () => Promise.resolve(controller), [
        cliInit("app:start", "inv-1"),
        treeStart("proxy", ["traefik"], "Starting proxy"),
        taskStart("traefik", "proxy"),
        taskComplete("traefik"),
        treeComplete("proxy", "Proxy ready"),
        cliRun("app:start", "inv-1"),
      ]),
    );
    const footers = footerTexts(controller);
    expect(footers[0]).toBe("╭─ start");
    expect(footers.some((text) => text.includes("traefik"))).toBe(true);
    const committed = committedText(controller);
    expect(committed.match(/╭─/g)).toHaveLength(1);
    expect(committed).toContain("╭─ app:start");
    expect(committed).not.toContain("╭─ start\n");
    expect(committed).not.toMatch(/^╭─ start$/m);
  });

  test("matching run without a tree clears the footer and never commits it", async () => {
    const { io } = ttyIo();
    const controller = new FakeController();
    await Effect.runPromise(
      drive(io, () => Promise.resolve(controller), [
        cliInit("app:restart", "inv-1"),
        cliRun("app:restart", "inv-1"),
      ]),
    );
    expect(footerTexts(controller)[0]).toBe("╭─ restart");
    const lastFooter = [...controller.calls].reverse().find((call) => call.kind === "setFooter");
    expect(lastFooter?.kind === "setFooter" && lastFooter.lines.length).toBe(0);
    expect(controller.calls.filter((call) => call.kind === "commitScrollback")).toEqual([]);
  });

  test("matching error without a tree clears the footer and never commits it", async () => {
    const { io } = ttyIo();
    const controller = new FakeController();
    await Effect.runPromise(
      drive(io, () => Promise.resolve(controller), [
        cliInit("app:rebuild", "inv-1"),
        cliError("app:rebuild", "inv-1"),
      ]),
    );
    expect(footerTexts(controller)[0]).toBe("╭─ rebuild");
    const lastFooter = [...controller.calls].reverse().find((call) => call.kind === "setFooter");
    expect(lastFooter?.kind === "setFooter" && lastFooter.lines.length).toBe(0);
    expect(controller.calls.filter((call) => call.kind === "commitScrollback")).toEqual([]);
  });

  test("prompt-first and nested inits do not acquire on init", async () => {
    const { io } = ttyIo();
    const controller = new FakeController();
    let acquisitions = 0;
    await Effect.runPromise(
      drive(
        io,
        () => {
          acquisitions += 1;
          return Promise.resolve(controller);
        },
        [
          cliInit("apps:init", "inv-1"),
          cliInit("meta:setup", "inv-2"),
          cliInit("app:destroy", "inv-3"),
          cliInit("mysql", "inv-4"),
          cliInit("app:start", "inv-6", "inv-5"),
        ],
      ),
    );
    expect(acquisitions).toBe(0);
    expect(controller.calls).toEqual([]);
  });

  test("two sequential trees under lifecycle commit once with one header and both rows", async () => {
    const { io } = ttyIo();
    const controller = new FakeController();
    await Effect.runPromise(
      drive(io, () => Promise.resolve(controller), [
        cliInit("app:start", "inv-1"),
        treeStart("proxy", ["traefik"], "Starting proxy"),
        taskStart("traefik", "proxy"),
        taskComplete("traefik"),
        treeComplete("proxy", "Proxy ready"),
        treeStart("routes", ["appserver"], "Starting routes"),
        taskStart("appserver", "routes"),
        taskComplete("appserver"),
        treeComplete("routes", "Routes ready"),
        cliRun("app:start", "inv-1"),
      ]),
    );
    const committed = committedText(controller);
    expect(committed.match(/╭─/g)).toHaveLength(1);
    expect(committed).toContain("╭─ app:start");
    expect(committed).toContain("traefik ready");
    expect(committed).toContain("appserver ready");
    expect(committed.match(/╰─/g)).toHaveLength(1);
    expect(committed).not.toContain("Starting proxy");
    const treeCommits = controller.calls.filter(
      (call) => call.kind === "commitScrollback" && call.text.includes("╭─"),
    );
    expect(treeCommits).toHaveLength(1);
    const lastFooter = [...controller.calls].reverse().find((call) => call.kind === "setFooter");
    expect(lastFooter?.kind === "setFooter" && lastFooter.lines.length).toBe(0);
  });

  test("nested lifecycle events do not open or close the outer session", async () => {
    const { io } = ttyIo();
    const controller = new FakeController();
    await Effect.runPromise(
      drive(io, () => Promise.resolve(controller), [
        cliInit("app:start", "inv-1"),
        treeStart("proxy", ["traefik"]),
        taskStart("traefik", "proxy"),
        cliInit("app:info", "inv-2", "inv-1"),
        cliRun("app:info", "inv-2", "inv-1"),
        taskComplete("traefik"),
        treeComplete("proxy", "Proxy ready"),
        cliRun("app:start", "inv-1"),
      ]),
    );
    const committed = committedText(controller);
    expect(committed.match(/╭─/g)).toHaveLength(1);
    expect(committed).toContain("╭─ app:start");
  });

  test("mismatched terminal events do not commit the armed session", async () => {
    const { io } = ttyIo();
    const controller = new FakeController();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const svc = yield* EventService;
          for (const event of [
            cliInit("app:start", "inv-1"),
            treeStart("proxy", ["traefik"]),
            taskStart("traefik", "proxy"),
            taskComplete("traefik"),
            treeComplete("proxy", "Proxy ready"),
            cliRun("app:start", "inv-other"),
          ]) {
            yield* svc.publish(event);
          }
          yield* Effect.sleep("20 millis");
          expect(committedText(controller)).not.toContain("╭─");
        }).pipe(
          Effect.provide(
            Layer.provideMerge(
              makeLandoEventConsumer(io, { createLiveRegion: () => Promise.resolve(controller) }),
              EventServiceLive,
            ),
          ),
        ),
      ),
    );
  });

  test("run then dispose does not double-commit", async () => {
    const { io } = ttyIo();
    const controller = new FakeController();
    await Effect.runPromise(
      drive(io, () => Promise.resolve(controller), [
        cliInit("app:start", "inv-1"),
        treeStart("proxy", ["traefik"]),
        taskStart("traefik", "proxy"),
        taskComplete("traefik"),
        treeComplete("proxy", "Proxy ready"),
        cliRun("app:start", "inv-1"),
      ]),
    );
    const headers = committedText(controller).match(/╭─ app:start/g) ?? [];
    expect(headers).toHaveLength(1);
  });

  test("error terminal commits the aggregate once", async () => {
    const { io } = ttyIo();
    const controller = new FakeController();
    await Effect.runPromise(
      drive(io, () => Promise.resolve(controller), [
        cliInit("app:start", "inv-1"),
        treeStart("proxy", ["traefik"]),
        taskStart("traefik", "proxy"),
        taskComplete("traefik"),
        treeComplete("proxy", "Proxy ready"),
        cliError("app:start", "inv-1"),
      ]),
    );
    expect(committedText(controller).match(/╭─ app:start/g)).toHaveLength(1);
  });

  test("dispose before terminal flushes an open session once", async () => {
    const { io } = ttyIo();
    const controller = new FakeController();
    await Effect.runPromise(
      drive(io, () => Promise.resolve(controller), [
        cliInit("app:start", "inv-1"),
        treeStart("proxy", ["traefik"]),
        taskStart("traefik", "proxy"),
        taskComplete("traefik"),
        treeComplete("proxy", "Proxy ready"),
      ]),
    );
    expect(committedText(controller).match(/╭─ app:start/g)).toHaveLength(1);
  });

  test("no-tasks lifecycle commits nothing", async () => {
    const { io } = ttyIo();
    const controller = new FakeController();
    await Effect.runPromise(
      drive(io, () => Promise.resolve(controller), [
        cliInit("app:info", "inv-1"),
        cliRun("app:info", "inv-1"),
      ]),
    );
    expect(controller.calls.filter((call) => call.kind === "commitScrollback")).toEqual([]);
    expect(controller.calls.filter((call) => call.kind === "setFooter")).toEqual([]);
  });

  test("without lifecycle, each tree still commits immediately", async () => {
    const { io } = ttyIo();
    const controller = new FakeController();
    await Effect.runPromise(
      drive(io, () => Promise.resolve(controller), [
        treeStart("proxy", ["traefik"], "Starting proxy"),
        taskStart("traefik", "proxy"),
        taskComplete("traefik"),
        treeComplete("proxy", "Proxy ready"),
        treeStart("routes", ["appserver"], "Starting routes"),
        taskStart("appserver", "routes"),
        taskComplete("appserver"),
        treeComplete("routes", "Routes ready"),
      ]),
    );
    const committed = committedText(controller);
    expect(committed.match(/╭─/g)?.length).toBeGreaterThan(1);
    expect(committed).toContain("Proxy ready");
    expect(committed).toContain("Routes ready");
  });

  test("non-tree messages still commit immediately during a session", async () => {
    const { io } = ttyIo();
    const controller = new FakeController();
    await Effect.runPromise(
      drive(io, () => Promise.resolve(controller), [
        cliInit("app:start", "inv-1"),
        treeStart("proxy", ["traefik"]),
        taskStart("traefik", "proxy"),
        warn("heads up"),
        taskComplete("traefik"),
        treeComplete("proxy", "Proxy ready"),
        cliRun("app:start", "inv-1"),
      ]),
    );
    expect(committedText(controller)).toContain("heads up");
  });

  test("a later phase tree.start does not exit full tail while build remains expanded", async () => {
    const { io } = ttyIo();
    const controller = new FakeController();
    const transcriptReader = new FakeTranscriptReader();
    const buildPath = AbsolutePath.make("/tmp/lando/builds/appserver.log");
    transcriptReader.set(buildPath, ["build output"]);
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const svc = yield* EventService;
          yield* svc.publish(cliInit("app:start", "inv-1"));
          yield* svc.publish(treeStart("build", ["appserver"], "Building"));
          yield* svc.publish(taskStart("appserver", "build", buildPath));
          yield* Effect.sleep("20 millis");
          yield* svc.publish(
            Schema.decodeUnknownSync(TaskDetailExpandEvent)({
              _tag: "task.detail.expand",
              taskId: "appserver",
              timestamp: ts,
            }),
          );
          yield* Effect.sleep("20 millis");
          const exitsAfterExpand = controller.calls.filter((call) => call.kind === "exitFullTail").length;
          expect(controller.calls.some((call) => call.kind === "enterFullTail")).toBe(true);
          yield* svc.publish(treeStart("apply", ["appserver"], "Applying"));
          yield* svc.publish(taskStart("appserver", "apply"));
          yield* Effect.sleep("20 millis");
          expect(controller.calls.filter((call) => call.kind === "exitFullTail")).toHaveLength(
            exitsAfterExpand,
          );
          const footer = [...controller.calls].reverse().find((call) => call.kind === "setFooter");
          expect(footer?.kind === "setFooter" && footer.lines.map(stripAnsi).join("\n")).toContain(
            "╭─ appserver",
          );
        }).pipe(
          Effect.provide(
            Layer.provideMerge(
              makeLandoEventConsumer(io, {
                createLiveRegion: () => Promise.resolve(controller),
                transcriptReader,
              }),
              EventServiceLive,
            ),
          ),
        ),
      ),
    );
  });
});
