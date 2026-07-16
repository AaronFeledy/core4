import { describe, expect, test } from "bun:test";
import { Effect, Layer, Queue, Schema } from "effect";

import { type LandoEvent, TaskDetailEvent, TaskStartEvent, TaskTreeStartEvent } from "@lando/sdk/events";
import { EventService } from "@lando/sdk/services";

import { makeLandoEventConsumer } from "../../../plugins/renderer-lando/src/renderer-runtime.ts";
import { createBufferedRendererIO } from "../../src/cli/renderer/io.ts";
import { EventServiceLive } from "../../src/services/event-service.ts";

class FakeLiveRegion {
  setFooter(): void {}
  commitScrollback(): void {}
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
  externalOutputStream: { write: () => true } as unknown as NodeJS.WriteStream,
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
      makeLandoEventConsumer(io, { createLiveRegion: () => Promise.resolve(new FakeLiveRegion()) }),
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

    // US-456 Wave 5 (sandbox): native alt-screen transition
  });
});
