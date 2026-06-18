import { describe, expect, test } from "bun:test";
import { Effect, Layer, Queue, Schema } from "effect";

import { type LandoEvent, TaskDetailEvent, TaskStartEvent, TaskTreeStartEvent } from "@lando/sdk/events";
import { EventService } from "@lando/sdk/services";

import { landoRenderer } from "../../src/cli/renderer/bundled-renderers.ts";
import { createBufferedRendererIO } from "../../src/cli/renderer/io.ts";
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

const stripCsi = (text: string): string => {
  const esc = String.fromCharCode(27);
  return text.replace(new RegExp(`${esc}\\[[0-9;]*[A-Za-z]`, "g"), "");
};

describe("lando renderer (TTY keybindings)", () => {
  test("Enter expands the focused task and publishes task.detail.expand; Esc collapses and publishes task.detail.collapse", async () => {
    const io = createBufferedRendererIO({ isTTY: true, terminalRows: 40 });

    const program = Effect.gen(function* () {
      const svc = yield* EventService;
      const collector = yield* svc.subscribeQueue;

      yield* svc.publish(treeStart("build", "Building", ["a"]));
      yield* svc.publish(taskStart("a", "step a", "build"));
      for (let n = 0; n < 10; n += 1) yield* svc.publish(detail("a", `line-${n}`));
      yield* Effect.sleep("40 millis");

      const beforeExpand = io.stdout().length;
      io.injectKey("\r");
      yield* Effect.sleep("40 millis");
      const afterExpand = io.stdout().slice(beforeExpand);

      const beforeCollapse = io.stdout().length;
      io.injectKey("\x1b");
      yield* Effect.sleep("40 millis");
      const afterCollapse = io.stdout().slice(beforeCollapse);

      const drained = yield* Queue.takeAll(collector);
      return { afterExpand, afterCollapse, published: [...drained] };
    });

    const layer = Layer.provideMerge(landoRenderer.makeEventConsumer(io), EventServiceLive);
    const { afterExpand, afterCollapse, published } = await Effect.runPromise(
      Effect.scoped(program.pipe(Effect.provide(layer))),
    );

    expect(stripCsi(afterExpand)).toContain("line-0");
    expect(stripCsi(afterExpand)).toContain("line-9");

    expect(stripCsi(afterCollapse)).not.toContain("line-0");
    expect(stripCsi(afterCollapse)).toContain("line-9");

    const tags = published.map((event) => event._tag);
    expect(tags).toContain("task.detail.expand");
    expect(tags).toContain("task.detail.collapse");
    const expand = published.find((event) => event._tag === "task.detail.expand");
    const collapse = published.find((event) => event._tag === "task.detail.collapse");
    expect((expand as { taskId: string }).taskId).toBe("a");
    expect((collapse as { taskId: string }).taskId).toBe("a");
  });
});
