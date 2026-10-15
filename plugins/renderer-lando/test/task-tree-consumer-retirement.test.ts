import { afterEach, expect, test } from "bun:test";
import * as LandoEventService from "@lando/engine/services/event-service";
import { createBufferedRendererIO } from "@lando/renderer/io";
import {
  CliCommandInitEvent,
  TaskCompleteEvent,
  TaskStartEvent,
  TaskTreeCompleteEvent,
  TaskTreeStartEvent,
} from "@lando/sdk/events";
import { EventService, Renderer } from "@lando/sdk/services";
import { Effect, Exit, Fiber, Layer, Schema, Scope } from "effect";
import type { LiveRegionControllerOptions } from "../src/opentui/live-region-controller.ts";
import {
  getOpenTuiSubstrateAvailability,
  resetOpenTuiSubstrateAvailabilityForTests,
} from "../src/opentui/substrate-availability.ts";
import { makeLandoEventConsumer, makeLandoService } from "../src/renderer-runtime.ts";
import type { LiveRegionHandle } from "../src/task-tree-substrate-handler.ts";

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
        children: ["ready"],
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
