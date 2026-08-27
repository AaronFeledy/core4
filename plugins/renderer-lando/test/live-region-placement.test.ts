import { describe, expect, test } from "bun:test";
import { closeSync, openSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WriteStream } from "node:tty";

import { Effect, Layer, Schema } from "effect";

import { type LandoEvent, TaskStartEvent, TaskTreeStartEvent } from "@lando/sdk/events";
import { EventService } from "@lando/sdk/services";

import { EventServiceLive, createBufferedRendererIO } from "@lando/core/testing";

import { makeLandoEventConsumer } from "../src/renderer-runtime.ts";

const ts = "2026-05-19T12:00:00.000Z";
const ESC = String.fromCharCode(27);
const CUP_ROW_24 = new RegExp(`${ESC}\\[24[;H]`);
const FIRST_FRAME_CURSOR = new RegExp(`${ESC}\\[[0-9;]*[AJ]`);

const createRecordingStdout = async (columns: number, rows: number) => {
  const directory = await mkdtemp(join(tmpdir(), "lando-live-region-placement-"));
  const outputPath = join(directory, "stdout.log");
  const fd = openSync(outputPath, "w");
  const stdout = new WriteStream(fd);
  stdout.columns = columns;
  stdout.rows = rows;
  const chunks: string[] = [];
  const originalWrite = stdout.write.bind(stdout);
  stdout.write = ((
    chunk: string | Uint8Array,
    ...rest: Parameters<typeof stdout.write> extends [unknown, ...infer R] ? R : never
  ) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    return originalWrite(chunk, ...rest);
  }) as typeof stdout.write;
  return {
    stdout,
    captured: () => chunks.join(""),
    read: async (): Promise<string> => {
      await new Promise<void>((resolve) => {
        stdout.end(() => resolve());
      });
      closeSync(fd);
      return readFile(outputPath, "utf8");
    },
    cleanup: async (): Promise<void> => {
      await rm(directory, { recursive: true, force: true });
    },
  };
};

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
    const recording = await createRecordingStdout(80, 24);
    const base = createBufferedRendererIO({ isTTY: true, terminalColumns: 80, terminalRows: 24 });
    const io = { ...base, externalOutputStream: recording.stdout };

    try {
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
      const output = await recording.read();
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
    } finally {
      await recording.cleanup();
    }
  });
});
