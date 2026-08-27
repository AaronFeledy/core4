import { expect, test } from "bun:test";
import { Effect, Layer, Schema } from "effect";

import { MessageWarnEvent, TaskDetailEvent, TaskStartEvent, TaskTreeStartEvent } from "@lando/sdk/events";
import { EventService } from "@lando/sdk/services";

import { EventServiceLive, createBufferedRendererIO } from "@lando/core/testing";
import { makeLandoEventConsumer } from "../src/renderer-runtime.ts";
import { createTestLiveRegionController, makeLiveRegionFixture } from "./live-region-test-kit.ts";

const timestamp = "2026-07-17T12:00:00.000Z";
const ESC = String.fromCharCode(27);

test("semantic footer reflow completes before resize replay through production consumer wiring", async () => {
  // Given
  const fixture = makeLiveRegionFixture();
  const io = createBufferedRendererIO({ isTTY: true, terminalColumns: 80, terminalRows: 24 });
  const liveIo = { ...io, externalOutputStream: process.stdout };

  // When
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const events = yield* EventService;
        yield* events.publish(
          Schema.decodeUnknownSync(TaskTreeStartEvent)({
            _tag: "task.tree.start",
            parentId: "build",
            label: "Building",
            children: ["web"],
            timestamp,
          }),
        );
        yield* events.publish(
          Schema.decodeUnknownSync(TaskStartEvent)({
            _tag: "task.start",
            taskId: "web",
            label: "web",
            timestamp,
          }),
        );
        yield* events.publish(
          Schema.decodeUnknownSync(TaskDetailEvent)({
            _tag: "task.detail",
            taskId: "web",
            stream: "stdout",
            line: "a deliberately long build detail that must reflow before replay",
            timestamp,
          }),
        );
        yield* events.publish(
          Schema.decodeUnknownSync(MessageWarnEvent)({
            _tag: "message.warn",
            body: "heads up",
            timestamp,
          }),
        );
        yield* Effect.promise(() =>
          (async () => {
            for (let attempt = 0; attempt < 200; attempt += 1) {
              if (fixture.writes.join("").includes("Building")) return;
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
            throw new Error("timed out waiting for inline tree paint");
          })(),
        );

        fixture.writes.length = 0;
        fixture.emitResize(40, 12);
        yield* Effect.promise(() =>
          (async () => {
            for (let attempt = 0; attempt < 200; attempt += 1) {
              if (fixture.writes.join("").includes("Building")) return;
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
            throw new Error("timed out waiting for resized tree paint");
          })(),
        );

        // Then
        expect(fixture.calls).not.toContain("reset:true");
        expect(fixture.calls.some((call) => call.startsWith("cursor:"))).toBe(false);
        const painted = fixture.writes.join("");
        expect(painted).toContain("Building");
        const visibleLines = painted
          .replace(new RegExp(`${ESC}\\[[0-9;]*[A-Za-z]`, "g"), "")
          .split("\n")
          .filter((line) => line.length > 0);
        expect(visibleLines.every((line) => Bun.stringWidth(line) <= 40)).toBe(true);
      }).pipe(
        Effect.provide(
          Layer.provideMerge(
            makeLandoEventConsumer(liveIo, {
              createLiveRegion: (options) => createTestLiveRegionController(fixture, options),
            }),
            EventServiceLive,
          ),
        ),
      ),
    ),
  );
});
