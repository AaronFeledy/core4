import { expect, test } from "bun:test";
import { Effect, Layer, Schema } from "effect";

import { MessageWarnEvent, TaskDetailEvent, TaskStartEvent, TaskTreeStartEvent } from "@lando/sdk/events";
import { EventService } from "@lando/sdk/services";

import { createBufferedRendererIO } from "../../../core/src/cli/renderer/io.ts";
import { EventServiceLive } from "../../../core/src/services/event-service.ts";
import { makeLandoEventConsumer } from "../src/renderer-runtime.ts";
import { createTestLiveRegionController, makeLiveRegionFixture } from "./live-region-test-kit.ts";

const timestamp = "2026-07-17T12:00:00.000Z";

test("semantic footer reflow completes before resize replay through production consumer wiring", async () => {
  // Given
  let signalInitialFrame: (() => void) | undefined;
  const initialFrame = new Promise<void>((resolve) => {
    signalInitialFrame = resolve;
  });
  const fixture = makeLiveRegionFixture((call) => {
    if (!call.startsWith("scrollback:")) return;
    signalInitialFrame?.();
    signalInitialFrame = undefined;
  });
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
        yield* Effect.promise(() => initialFrame);

        fixture.calls.length = 0;
        fixture.emitResize(40, 12);

        // Then
        const reflowIndex = fixture.calls.findIndex((call) => call.startsWith("footer:"));
        const resetIndex = fixture.calls.indexOf("reset:true");
        const replayIndex = fixture.calls.findIndex((call) => call.startsWith("scrollback:"));
        expect(reflowIndex).toBeGreaterThanOrEqual(0);
        expect(resetIndex).toBeGreaterThan(reflowIndex);
        expect(replayIndex).toBeGreaterThan(resetIndex);
        const replayedFooter = fixture.calls.slice(resetIndex + 1).find((call) => call.startsWith("footer:"));
        expect(replayedFooter).toBeDefined();
        expect(
          replayedFooter
            ?.slice("footer:".length)
            .split("|")
            .every((line) => Bun.stringWidth(line) <= 40),
        ).toBe(true);
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
