import { describe, expect, test } from "bun:test";

import { Effect, Layer, Schema } from "effect";

import { type LandoEvent, TaskStartEvent, TaskTreeStartEvent } from "@lando/sdk/events";
import { EventService } from "@lando/sdk/services";

import { EventServiceLive, createBufferedRendererIO } from "@lando/core/testing";

import { makeLandoEventConsumer } from "../src/renderer-runtime.ts";
import { createRecordingStdout } from "./live-region-test-kit.ts";

const ts = "2026-05-19T12:00:00.000Z";
const ESC = String.fromCharCode(27);
const CUP_ROW_24 = new RegExp(`${ESC}\\[24[;H]`);
const FIRST_FRAME_CURSOR = new RegExp(`${ESC}\\[[0-9;]*[AJ]`);

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

const waitForPaint = (ready: () => boolean): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      if (ready()) return;
      yield* Effect.sleep("5 millis");
    }
    return yield* Effect.fail(new Error("Renderer consumer did not paint the live region."));
  });

describe("TTY task tree live-region placement", () => {
  test("paints the rail inline without jumping to the terminal footer", async () => {
    const recording = createRecordingStdout(80, 24);
    const base = createBufferedRendererIO({ isTTY: true, terminalColumns: 80, terminalRows: 24 });
    const io = { ...base, externalOutputStream: recording.stdout as unknown as NodeJS.WriteStream };

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const events = yield* EventService;
          yield* events.publish(treeStart("app", "Starting app", ["web", "db"]));
          yield* events.publish(taskStart("web", "web service", "app"));
          yield* waitForPaint(() => recording.captured().includes("╭─"));
        }).pipe(Effect.provide(Layer.provideMerge(makeLandoEventConsumer(io), EventServiceLive))),
      ),
    );
    const output = recording.captured();
    const railIndex = output.indexOf("╭─");
    const firstRail = output.indexOf("╭");
    const firstLineEnd = railIndex === -1 ? -1 : output.indexOf("\n", railIndex);
    const firstTreeEnd = firstLineEnd === -1 ? railIndex + "╭─".length : firstLineEnd + 1;
    const firstTreePrefix = output.slice(0, Math.max(0, firstTreeEnd));
    const beforeRail = firstRail === -1 ? output : output.slice(0, firstRail);

    expect(output).toContain("╭─");
    expect(output.includes("◌") || output.includes("web service")).toBe(true);
    expect(beforeRail.includes("\n\n\n")).toBe(false);
    expect(output).not.toMatch(CUP_ROW_24);
    expect(firstTreePrefix).not.toMatch(FIRST_FRAME_CURSOR);
  });
});
