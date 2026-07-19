import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";
import { Deferred, Effect, Layer, Schema } from "effect";

import {
  type LandoEvent,
  PreBootstrapMinimalEvent,
  TaskCompleteEvent,
  TaskDetailEvent,
  TaskFailEvent,
  TaskStartEvent,
  TaskTreeCompleteEvent,
  TaskTreeStartEvent,
} from "@lando/sdk/events";
import { StreamFrame } from "@lando/sdk/schema";
import { EventService } from "@lando/sdk/services";

import { renderJsonLine, renderPlainLine } from "../../src/cli/renderer/format.ts";
import { createBufferedRendererIO } from "../../src/cli/renderer/io.ts";
import {
  makeJsonRendererLive,
  makePlainRendererLive,
  renderJson,
  renderPlain,
} from "../../src/cli/renderer/runtime.ts";
import { EventServiceLive } from "../../src/services/event-service.ts";

const fixturePath = resolve(import.meta.dirname, "fixtures/renderer.task-tree.concurrent.ndjson");
const fixtureContent = readFileSync(fixturePath, "utf8");

const parseNdjson = (content: string): ReadonlyArray<LandoEvent> => {
  const lines = content.split("\n").filter((line) => line.trim().length > 0);
  return lines.map((line) => JSON.parse(line) as LandoEvent);
};

const fixtureEvents = parseNdjson(fixtureContent);

const decodeEventFrame = (line: string) => {
  const frame = Schema.decodeUnknownSync(StreamFrame)(JSON.parse(line));
  expect(frame._tag).toBe("event");
  if (frame._tag !== "event") throw new Error("expected event frame");
  return frame;
};

const decodeFixtureEvents = (): ReadonlyArray<LandoEvent> => {
  const decoded: LandoEvent[] = [];
  for (const raw of fixtureEvents) {
    switch (raw._tag) {
      case "task.tree.start":
        decoded.push(Schema.decodeUnknownSync(TaskTreeStartEvent)(raw));
        break;
      case "task.start":
        decoded.push(Schema.decodeUnknownSync(TaskStartEvent)(raw));
        break;
      case "task.detail":
        decoded.push(Schema.decodeUnknownSync(TaskDetailEvent)(raw));
        break;
      case "task.complete":
        decoded.push(Schema.decodeUnknownSync(TaskCompleteEvent)(raw));
        break;
      case "task.fail":
        decoded.push(Schema.decodeUnknownSync(TaskFailEvent)(raw));
        break;
      case "task.tree.complete":
        decoded.push(Schema.decodeUnknownSync(TaskTreeCompleteEvent)(raw));
        break;
      default:
        throw new Error(`unexpected fixture event _tag: ${raw._tag}`);
    }
  }
  return decoded;
};

describe("plain renderer (non-TTY)", () => {
  test("renders task.tree.start with services count", () => {
    const event = fixtureEvents[0];
    if (event === undefined) throw new Error("missing fixture event");
    expect(renderPlainLine(event)).toBe("▼ Building app dependencies (3 services)");
  });

  test("renders task.start with [stepId] prefix", () => {
    const event = fixtureEvents.find((e) => e._tag === "task.start");
    if (event === undefined) throw new Error("missing task.start fixture");
    const taskId = (event as Record<string, unknown>).taskId;
    const line = renderPlainLine(event);
    expect(line).toContain(`[${String(taskId)}]`);
    expect(line).toContain("start");
  });

  test("renders task.detail with stable [stepId] prefix and stderr marker", () => {
    const stdoutDetail = fixtureEvents.find(
      (e) =>
        e._tag === "task.detail" &&
        (e as Record<string, unknown>).stream === "stdout" &&
        (e as Record<string, unknown>).taskId === "node",
    );
    const stderrDetail = fixtureEvents.find(
      (e) => e._tag === "task.detail" && (e as Record<string, unknown>).stream === "stderr",
    );
    if (stdoutDetail === undefined || stderrDetail === undefined) {
      throw new Error("missing task.detail fixtures");
    }
    const stdoutLine = renderPlainLine(stdoutDetail);
    const stderrLine = renderPlainLine(stderrDetail);
    expect(stdoutLine).toBe("[node] added 142 packages in 8.2s");
    expect(stderrLine).toBe("[node] ! npm warn deprecated foo@1.0.0");
  });

  test("renders task.complete with summary and duration", () => {
    const event = fixtureEvents.find(
      (e) => e._tag === "task.complete" && (e as Record<string, unknown>).taskId === "appserver",
    );
    if (event === undefined) throw new Error("missing task.complete fixture");
    expect(renderPlainLine(event)).toBe("[appserver] ✓ complete: composer install (12.4s)");
  });

  test("renders task.fail with exit code and remediation", () => {
    const event = fixtureEvents.find((e) => e._tag === "task.fail");
    if (event === undefined) throw new Error("missing task.fail fixture");
    const rendered = renderPlainLine(event);
    expect(rendered).toContain("[node] ✗ fail: npm ci (exit 1)");
    expect(rendered).toContain("↳ see lando logs node --build");
  });

  test("renders task.tree.complete summary with counts", () => {
    const event = fixtureEvents.find((e) => e._tag === "task.tree.complete");
    if (event === undefined) throw new Error("missing task.tree.complete fixture");
    expect(renderPlainLine(event)).toBe("▶ Built app dependencies (2 ✓ · 1 ✗) (13.1s)");
  });

  test("output is plain-text (no ANSI escape codes) and one event per line", () => {
    const io = createBufferedRendererIO();
    renderPlain(io, fixtureEvents);
    const output = io.stdout();
    const escapeChar = String.fromCharCode(27);
    const ansiPattern = `${escapeChar}[`;
    expect(output.includes(ansiPattern)).toBe(false);
    expect(io.stdoutLines().length).toBeGreaterThan(0);
  });
});

describe("json renderer", () => {
  test("emits one NDJSON line per task tree event on stderr", () => {
    const io = createBufferedRendererIO();
    renderJson(io, fixtureEvents);
    const lines = io.stderrLines();
    expect(lines.length).toBe(fixtureEvents.length);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line === undefined) throw new Error("missing rendered line");
      const parsed = decodeEventFrame(line);
      const expectedEvent = fixtureEvents[index];
      if (expectedEvent === undefined) throw new Error("missing fixture event");
      expect(parsed.event).toBe(expectedEvent._tag);
      expect((parsed.payload as LandoEvent)._tag).toBe(expectedEvent._tag);
    }
  });

  test("renderJsonLine returns null for non-renderable events", () => {
    const event = Schema.decodeUnknownSync(PreBootstrapMinimalEvent)({
      _tag: "pre-bootstrap-minimal",
      timestamp: "2026-07-19T00:00:00.000Z",
    });
    expect(renderJsonLine(event)).toBeNull();
  });

  test("stdout stays empty when only json renderer is used", () => {
    const io = createBufferedRendererIO();
    renderJson(io, fixtureEvents);
    expect(io.stdout()).toBe("");
  });
});

describe("snapshot: renderer.task-tree.concurrent.ndjson", () => {
  const events = decodeFixtureEvents();

  test("plain renderer preserves event arrival order (snapshot)", () => {
    const io = createBufferedRendererIO();
    renderPlain(io, events);
    expect(io.stdout()).toMatchSnapshot();
  });

  test("json renderer preserves event arrival order and tags (snapshot)", () => {
    const io = createBufferedRendererIO();
    renderJson(io, events);
    expect(io.stderr()).toMatchSnapshot();
  });

  test("ordering: tree.start → child task.start → task.detail → terminal events → tree.complete", () => {
    const io = createBufferedRendererIO();
    renderJson(io, events);
    const lines = io.stderrLines();
    const tags: ReadonlyArray<LandoEvent["_tag"]> = lines.map(
      (line) => decodeEventFrame(line).event as LandoEvent["_tag"],
    );

    expect(tags[0]).toBe("task.tree.start");
    expect(tags[tags.length - 1]).toBe("task.tree.complete");

    const firstTaskStart = tags.indexOf("task.start");
    const lastTaskStart = tags.lastIndexOf("task.start");
    const firstTaskDetail = tags.indexOf("task.detail");
    const terminalTags: ReadonlyArray<LandoEvent["_tag"]> = ["task.complete", "task.fail"];
    const firstTerminal = Math.min(
      ...(terminalTags
        .map((tag) => tags.indexOf(tag))
        .filter((index) => index >= 0) as ReadonlyArray<number>),
    );
    const treeComplete = tags.indexOf("task.tree.complete");

    expect(firstTaskStart).toBeGreaterThan(0);
    expect(lastTaskStart).toBeLessThan(firstTaskDetail);
    expect(firstTaskDetail).toBeLessThan(firstTerminal);
    expect(firstTerminal).toBeLessThan(treeComplete);
  });
});

describe("cold-start regression: no events dropped before first task.tree.start", () => {
  test("plain renderer Layer materializes subscription before first publish", async () => {
    const io = createBufferedRendererIO();
    const program = Effect.gen(function* () {
      const events = yield* EventService;
      const treeStart = Schema.decodeUnknownSync(TaskTreeStartEvent)({
        _tag: "task.tree.start",
        parentId: "build-app",
        label: "Building",
        children: ["a"],
        timestamp: "2026-05-19T12:00:00.000Z",
      });
      const childStart = Schema.decodeUnknownSync(TaskStartEvent)({
        _tag: "task.start",
        taskId: "a",
        parentId: "build-app",
        label: "step a",
        timestamp: "2026-05-19T12:00:00.001Z",
      });
      const childComplete = Schema.decodeUnknownSync(TaskCompleteEvent)({
        _tag: "task.complete",
        taskId: "a",
        summary: "step a",
        durationMs: 10,
        timestamp: "2026-05-19T12:00:00.010Z",
      });
      const treeComplete = Schema.decodeUnknownSync(TaskTreeCompleteEvent)({
        _tag: "task.tree.complete",
        parentId: "build-app",
        summary: "Built",
        succeeded: 1,
        failed: 0,
        durationMs: 11,
        timestamp: "2026-05-19T12:00:00.011Z",
      });
      yield* events.publish(treeStart);
      yield* events.publish(childStart);
      yield* events.publish(childComplete);
      yield* events.publish(treeComplete);
      yield* Effect.yieldNow();
      yield* Effect.sleep("20 millis");
    });

    const layer = Layer.provideMerge(makePlainRendererLive(io), EventServiceLive);
    await Effect.runPromise(Effect.scoped(program.pipe(Effect.provide(layer))));

    const lines = io.stdoutLines();
    expect(lines.length).toBe(4);
    expect(lines[0]).toContain("▼ Building");
    expect(lines[1]).toContain("[a] start");
    expect(lines[2]).toContain("[a] ✓ complete");
    expect(lines[3]).toContain("▶ Built");
  });

  test("json renderer receives every event published immediately after layer construction", async () => {
    const io = createBufferedRendererIO();
    const program = Effect.gen(function* () {
      const events = yield* EventService;
      const ready = yield* Deferred.make<void>();
      yield* Deferred.succeed(ready, void 0);
      yield* Deferred.await(ready);
      for (let index = 0; index < 5; index += 1) {
        yield* events.publish(
          Schema.decodeUnknownSync(TaskStartEvent)({
            _tag: "task.start",
            taskId: `task-${index}`,
            parentId: "p",
            label: `task ${index}`,
            timestamp: "2026-05-19T12:00:00.000Z",
          }),
        );
      }
      yield* Effect.sleep("20 millis");
    });

    const layer = Layer.provideMerge(makeJsonRendererLive(io), EventServiceLive);
    await Effect.runPromise(Effect.scoped(program.pipe(Effect.provide(layer))));

    const lines = io.stderrLines();
    expect(lines.length).toBe(5);
    for (let index = 0; index < 5; index += 1) {
      const parsed = decodeEventFrame(lines[index] ?? "null");
      expect(parsed.event).toBe("task.start");
      expect((parsed.payload as Record<string, unknown>).taskId).toBe(`task-${index}`);
    }
  });
});
