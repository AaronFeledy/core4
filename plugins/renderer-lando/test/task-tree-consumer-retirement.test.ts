import { afterEach, expect, test } from "bun:test";
import * as LandoEventService from "@lando/engine/services/event-service";
import { createBufferedRendererIO } from "@lando/renderer/io";
import {
  CliCommandInitEvent,
  MessageInfoEvent,
  TaskCompleteEvent,
  TaskStartEvent,
  TaskTreeCompleteEvent,
  TaskTreeStartEvent,
} from "@lando/sdk/events";
import { EventService, Renderer } from "@lando/sdk/services";
import { Effect, Exit, Fiber, Layer, Schema, Scope } from "effect";
import {
  type LiveRegionControllerOptions,
  createLiveRegionController,
} from "../src/opentui/live-region-controller.ts";
import {
  getOpenTuiSubstrateAvailability,
  resetOpenTuiSubstrateAvailabilityForTests,
} from "../src/opentui/substrate-availability.ts";
import { makeLandoEventConsumer, makeLandoService } from "../src/renderer-runtime.ts";
import type { LiveRegionHandle } from "../src/task-tree-substrate-handler.ts";
import { createCapturingStdout } from "./live-region-test-kit.ts";

afterEach(resetOpenTuiSubstrateAvailabilityForTests);

test.each(["in-flight acquisition", "active input", "disposal failure"] as const)(
  "closing during %s drains final status and releases terminal ownership",
  async (mode) => {
    // Given
    const io = createBufferedRendererIO({ isTTY: true, terminalColumns: 80, terminalRows: 24 });
    const frames: string[][] = [];
    const writes: string[] = [];
    let disposed = 0;
    let subscriptions = 0;
    let interruptions = 0;
    let retainedInput: (raw: string) => void = () => {};
    let retainedResize: (width: number, height: number) => void = () => {};
    const acquiring = Promise.withResolvers<void>();
    const acquired = Promise.withResolvers<LiveRegionHandle>();
    const subscribed = Promise.withResolvers<void>();
    const controller: LiveRegionHandle = {
      setFooter: (lines) => {
        frames.push([...lines]);
      },
      clearFooter: () => {
        frames.push([]);
      },
      commitScrollback: (text) => {
        writes.push(text);
      },
      rememberScrollback: () => {},
      requestLive: () => {},
      dropLive: () => {},
      enterFullTail: () => {},
      exitFullTail: () => Promise.resolve(),
      dispose: () => {
        disposed++;
        return mode === "disposal failure"
          ? Promise.reject(new TypeError("dispose failed"))
          : Promise.resolve();
      },
    };
    const ttyIo = {
      ...io,
      externalOutputStream: process.stdout,
      subscribeInput: (listener: (raw: string) => void) => {
        subscriptions++;
        retainedInput = listener;
        subscribed.resolve();
        return () => {
          subscriptions--;
        };
      },
    };
    const timestamp = "2026-10-13T00:00:00Z";
    const events = [
      Schema.decodeUnknownSync(CliCommandInitEvent)({
        _tag: "cli-apps:scratch:run-init",
        commandId: "apps:scratch:run",
        argv: [],
        args: {},
        flags: {},
        cwd: "/app",
        invocationId: "retirement",
        timestamp,
      }),
      Schema.decodeUnknownSync(TaskTreeStartEvent)({
        _tag: "task.tree.start",
        parentId: "acquire",
        label: "Acquiring scratch",
        children: [{ id: "ready", label: "ready" }],
        timestamp,
      }),
      Schema.decodeUnknownSync(TaskStartEvent)({
        _tag: "task.start",
        taskId: "ready",
        parentId: "acquire",
        label: "Scratch ready",
        timestamp,
      }),
      Schema.decodeUnknownSync(TaskCompleteEvent)({
        _tag: "task.complete",
        taskId: "ready",
        summary: "ready",
        durationMs: 1,
        timestamp,
      }),
      Schema.decodeUnknownSync(TaskTreeCompleteEvent)({
        _tag: "task.tree.complete",
        parentId: "acquire",
        succeeded: 1,
        failed: 0,
        durationMs: 1,
        timestamp,
      }),
    ] as const;
    // When
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* EventService;
          const renderer = yield* Renderer;
          const consumerScope = yield* Scope.fork(yield* Effect.scope);
          yield* Layer.buildWithScope(
            makeLandoEventConsumer(ttyIo, {
              raiseInterrupt: () => {
                interruptions++;
              },
              createLiveRegion: (options: LiveRegionControllerOptions) => {
                retainedResize = options.onResize ?? (() => {});
                acquiring.resolve();
                return acquired.promise;
              },
            }),
            consumerScope,
          );
          for (const event of events) yield* service.publish(event);
          yield* Effect.promise(() => acquiring.promise);
          if (mode === "active input") {
            acquired.resolve(controller);
            yield* Effect.promise(() => subscribed.promise);
          }
          const closing = yield* Effect.forkChild(Scope.close(consumerScope, Exit.void));
          yield* Effect.yieldNow;
          acquired.resolve(controller);
          const exit = yield* Fiber.await(closing);
          // Then
          expect(disposed).toBe(1);
          expect(Exit.isSuccess(exit)).toBe(true);
          expect(getOpenTuiSubstrateAvailability().available).toBe(mode !== "disposal failure");
          expect(subscriptions).toBe(0);
          const finalFrame =
            frames
              .filter((lines) => lines.length > 0)
              .at(-1)
              ?.join("\n") ?? "";
          expect(finalFrame).toContain("ready");
          expect(finalFrame).not.toContain("pending");
          expect(finalFrame).toContain("✓");
          const paintCount = frames.length;
          retainedInput("\x03");
          retainedResize(120, 50);
          yield* service.publish(events[1]);
          yield* Effect.yieldNow;
          expect(frames).toHaveLength(paintCount);
          expect(interruptions).toBe(0);
          const before = io.stdout();
          yield* renderer.output.stdout("prompt> \x1b[2K");
          expect(io.stdout().slice(before.length)).toBe("prompt> \x1b[2K");
          expect(writes).toEqual([]);
        }),
      ).pipe(Effect.provide(Layer.mergeAll(LandoEventService.layer, makeLandoService(ttyIo)))),
    );
  },
);

const ESC = String.fromCharCode(27);

const replayInline = (output: string): string => {
  const rewind = new RegExp(`\\r?${ESC}\\[(\\d+)A${ESC}\\[J`, "g");
  const text = output.replace(/\r\n/g, "\n");
  let result = "";
  let last = 0;
  for (const match of text.matchAll(rewind)) {
    result += text.slice(last, match.index);
    const count = Number(match[1]);
    const ended = result.endsWith("\n");
    const parts = result.split("\n");
    if (ended) parts.pop();
    parts.splice(Math.max(0, parts.length - count), count);
    result = `${parts.join("\n")}${parts.length > 0 || ended ? "\n" : ""}`;
    last = (match.index ?? 0) + match[0].length;
  }
  return `${result}${text.slice(last)}`.replace(/\r/g, "").replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");
};

test("retiring after a message leaves the finished tree in scrollback once", async () => {
  const writes: string[] = [];
  const stdout = createCapturingStdout(writes);
  stdout.columns = 80;
  stdout.rows = 24;
  const io = createBufferedRendererIO({ isTTY: true, terminalColumns: 80, terminalRows: 24 });
  const ttyIo = { ...io, externalOutputStream: process.stdout };
  const timestamp = "2026-10-13T00:00:00Z";
  const infoBody = "Lando needs administrator access to install the CA.";
  const painted = Promise.withResolvers<void>();
  const treeEvents = [
    Schema.decodeUnknownSync(CliCommandInitEvent)({
      _tag: "cli-meta:setup-init",
      commandId: "meta:setup",
      argv: [],
      args: {},
      flags: {},
      cwd: "/app",
      invocationId: "setup-retire",
      timestamp,
    }),
    Schema.decodeUnknownSync(TaskTreeStartEvent)({
      _tag: "task.tree.start",
      parentId: "provider",
      label: "meta:setup",
      children: [{ id: "bundle", label: "Verify runtime bundle" }],
      timestamp,
    }),
    Schema.decodeUnknownSync(TaskStartEvent)({
      _tag: "task.start",
      taskId: "bundle",
      parentId: "provider",
      label: "Verify runtime bundle",
      timestamp,
    }),
    Schema.decodeUnknownSync(TaskCompleteEvent)({
      _tag: "task.complete",
      taskId: "bundle",
      summary: "Verify runtime bundle",
      durationMs: 107,
      timestamp,
    }),
    Schema.decodeUnknownSync(TaskTreeCompleteEvent)({
      _tag: "task.tree.complete",
      parentId: "provider",
      succeeded: 1,
      failed: 0,
      durationMs: 155,
      timestamp,
    }),
  ] as const;
  const info = Schema.decodeUnknownSync(MessageInfoEvent)({
    _tag: "message.info",
    body: infoBody,
    timestamp,
  });
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* EventService;
        const consumerScope = yield* Scope.fork(yield* Effect.scope);
        yield* Layer.buildWithScope(
          makeLandoEventConsumer(ttyIo, {
            createLiveRegion: async (options: LiveRegionControllerOptions) => {
              const controller = await createLiveRegionController({ ...options, stdout, noColor: true });
              return {
                setFooter: (lines: ReadonlyArray<string>) => {
                  controller.setFooter(lines);
                  if (lines.some((line) => line.includes("155ms"))) painted.resolve();
                },
                clearFooter: () => controller.clearFooter(),
                commitScrollback: (text: string) => controller.commitScrollback(text),
                rememberScrollback: (text: string) => controller.rememberScrollback(text),
                requestLive: () => controller.requestLive(),
                dropLive: () => controller.dropLive(),
                enterFullTail: () => controller.enterFullTail(),
                exitFullTail: () => controller.exitFullTail(),
                dispose: () => controller.dispose(),
              };
            },
          }),
          consumerScope,
        );
        for (const event of treeEvents) yield* service.publish(event);
        yield* Effect.promise(() => painted.promise);
        yield* service.publish(info);
        yield* Scope.close(consumerScope, Exit.void);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(LandoEventService.layer, makeLandoService(ttyIo)))),
  );
  const raw = writes.join("");
  expect([...raw.matchAll(/done {2}155ms/g)]).toHaveLength(1);
  const scrollback = replayInline(raw);
  expect(scrollback.match(/Verify runtime bundle/g)).toEqual(["Verify runtime bundle"]);
  expect(scrollback.match(/Lando needs administrator access to install the CA\./g)).toEqual([infoBody]);
  expect(scrollback.indexOf("Verify runtime bundle")).toBeLessThan(scrollback.indexOf(infoBody));
});
