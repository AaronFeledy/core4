import { describe, expect, test } from "bun:test";
import { Effect, Layer, Queue, Schema } from "effect";

import { type LandoEvent, TaskDetailEvent, TaskStartEvent, TaskTreeStartEvent } from "@lando/sdk/events";
import { AbsolutePath } from "@lando/sdk/schema";
import { EventService } from "@lando/sdk/services";

import { makeLandoEventConsumer } from "../../../plugins/renderer-lando/src/renderer-runtime.ts";
import { createBufferedRendererIO } from "../../src/cli/renderer/io.ts";
import { EventServiceLive } from "../../src/services/event-service.ts";

class FakeLiveRegion {
  setFooter(): void {}
  commitScrollback(): void {}
  rememberScrollback(): void {}
  requestLive(): void {}
  dropLive(): void {}
  resize(): void {}
  enterFullTail(): void {}
  exitFullTail(): void {}
  reset(): void {}
  dispose(): void {}
}

const substrateIo = (base: ReturnType<typeof createBufferedRendererIO>) => ({
  ...base,
  externalOutputStream: process.stdout,
});

const ts = "2026-05-19T12:00:00.000Z";

const treeStart = (parentId: string, label: string, children: ReadonlyArray<string>): LandoEvent =>
  Schema.decodeUnknownSync(TaskTreeStartEvent)({
    _tag: "task.tree.start",
    parentId,
    label,
    children,
    timestamp: ts,
  });

const taskStart = (taskId: string, label: string, parentId: string): LandoEvent =>
  Schema.decodeUnknownSync(TaskStartEvent)({
    _tag: "task.start",
    taskId,
    parentId,
    label,
    transcriptPath: AbsolutePath.make(`/tmp/lando/builds/${taskId}.log`),
    timestamp: ts,
  });

const detail = (taskId: string, line: string): LandoEvent =>
  Schema.decodeUnknownSync(TaskDetailEvent)({
    _tag: "task.detail",
    taskId,
    stream: "stdout",
    line,
    timestamp: ts,
  });

const transcriptReader = {
  open: (_path: typeof AbsolutePath.Type, _onChange: Effect.Effect<void>) =>
    Effect.acquireRelease(
      Effect.succeed({
        read: () => Effect.succeed({ lines: [] }),
      }),
      () => Effect.void,
    ),
};

describe("lando renderer (TTY keybindings)", () => {
  test("Enter expands the focused task and publishes task.detail.expand; Esc collapses and publishes task.detail.collapse", async () => {
    const base = createBufferedRendererIO({ isTTY: true, terminalRows: 40 });
    const io = substrateIo(base);

    const program = Effect.gen(function* () {
      const svc = yield* EventService;
      const collector = yield* svc.subscribeQueue;

      yield* svc.publish(treeStart("build", "Building", ["a"]));
      yield* svc.publish(taskStart("a", "step a", "build"));
      for (let n = 0; n < 10; n += 1) yield* svc.publish(detail("a", `line-${n}`));
      yield* Effect.sleep("40 millis");

      base.injectKey("\r");
      yield* Effect.sleep("40 millis");

      base.injectKey("\x1b");
      yield* Effect.sleep("40 millis");

      const drained = yield* Queue.takeAll(collector);
      return [...drained];
    });

    const layer = Layer.provideMerge(
      makeLandoEventConsumer(io, {
        createLiveRegion: () => Promise.resolve(new FakeLiveRegion()),
        transcriptReader,
      }),
      EventServiceLive,
    );
    const published = await Effect.runPromise(Effect.scoped(program.pipe(Effect.provide(layer))));

    const tags = published.map((event) => event._tag);
    expect(tags).toContain("task.detail.expand");
    expect(tags).toContain("task.detail.collapse");
    const expand = published.find((event) => event._tag === "task.detail.expand");
    const collapse = published.find((event) => event._tag === "task.detail.collapse");
    expect(expand).toBeDefined();
    expect(collapse).toBeDefined();
    expect(Reflect.get(expand ?? {}, "taskId")).toBe("a");
    expect(Reflect.get(collapse ?? {}, "taskId")).toBe("a");
    expect(tags.indexOf("task.detail.expand")).toBeLessThan(tags.indexOf("task.detail.collapse"));
  });

  test("Ctrl-C raises the command-runtime interrupt without publishing a tree key action", async () => {
    const base = createBufferedRendererIO({ isTTY: true, terminalRows: 40 });
    const io = substrateIo(base);
    let interrupts = 0;
    const deps = {
      createLiveRegion: () => Promise.resolve(new FakeLiveRegion()),
      raiseInterrupt: () => {
        interrupts += 1;
      },
    };

    const program = Effect.gen(function* () {
      const svc = yield* EventService;
      const collector = yield* svc.subscribeQueue;
      yield* svc.publish(treeStart("build", "Building", ["a"]));
      yield* svc.publish(taskStart("a", "step a", "build"));
      yield* Effect.sleep("20 millis");

      base.injectKey("\x03");
      yield* Effect.sleep("20 millis");

      return [...(yield* Queue.takeAll(collector))];
    });
    const layer = Layer.provideMerge(makeLandoEventConsumer(io, deps), EventServiceLive);
    const published = await Effect.runPromise(Effect.scoped(program.pipe(Effect.provide(layer))));

    expect(interrupts).toBe(1);
    expect(published.some((event) => event._tag === "task.detail.expand")).toBe(false);
    expect(published.some((event) => event._tag === "task.detail.collapse")).toBe(false);
  });

  test.each(["a\x03", "\x03\x1b[B"])(
    "a chunk containing Ctrl-C raises exactly one interrupt before key handling: %p",
    async (raw) => {
      const base = createBufferedRendererIO({ isTTY: true, terminalRows: 40 });
      const io = substrateIo(base);
      let interrupts = 0;
      const program = Effect.gen(function* () {
        const svc = yield* EventService;
        const collector = yield* svc.subscribeQueue;
        yield* svc.publish(treeStart("build", "Building", ["a"]));
        yield* svc.publish(taskStart("a", "step a", "build"));
        yield* Effect.sleep("20 millis");

        base.injectKey(raw);
        yield* Effect.sleep("20 millis");

        return [...(yield* Queue.takeAll(collector))];
      });
      const layer = Layer.provideMerge(
        makeLandoEventConsumer(io, {
          createLiveRegion: () => Promise.resolve(new FakeLiveRegion()),
          raiseInterrupt: () => {
            interrupts += 1;
          },
        }),
        EventServiceLive,
      );

      const published = await Effect.runPromise(Effect.scoped(program.pipe(Effect.provide(layer))));

      expect(interrupts).toBe(1);
      expect(published.some((event) => event._tag === "task.detail.expand")).toBe(false);
      expect(published.some((event) => event._tag === "task.detail.collapse")).toBe(false);
    },
  );
});
