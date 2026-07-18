import { expect, test } from "bun:test";
import { Effect, Layer, Schema } from "effect";

import { MessageWarnEvent, TaskStartEvent, TaskTreeStartEvent } from "@lando/sdk/events";
import { AbsolutePath } from "@lando/sdk/schema";
import { EventService } from "@lando/sdk/services";

import { createBufferedRendererIO } from "../../../core/src/cli/renderer/io.ts";
import { EventServiceLive } from "../../../core/src/services/event-service.ts";
import { createLiveRegionController } from "../src/opentui/live-region-controller.ts";
import type { LiveRegionSpoolFactory } from "../src/opentui/live-region-spool.ts";
import { makeLandoEventConsumer } from "../src/renderer-runtime.ts";
import { makeLiveRegionFixture } from "./live-region-test-kit.ts";

const timestamp = "2026-07-17T12:00:00.000Z";
const deferredBody = (prefix: string): string =>
  Array.from({ length: 3_000 }, (_, index) => `${prefix}-${index}-${"x".repeat(100)}`).join("\n");

test("collapse drains deferred output before later output and scope close awaits spool disposal", async () => {
  // Given
  const runningFrame = Promise.withResolvers<void>();
  const firstAlternateScreen = Promise.withResolvers<void>();
  const secondAlternateScreen = Promise.withResolvers<void>();
  const firstSpoolAppend = Promise.withResolvers<void>();
  const firstSpoolRead = Promise.withResolvers<void>();
  const allowFirstSpoolRead = Promise.withResolvers<void>();
  const newOutputCommitted = Promise.withResolvers<void>();
  const secondSpoolAppend = Promise.withResolvers<void>();
  const secondSpoolRemove = Promise.withResolvers<void>();
  const allowSecondSpoolRemove = Promise.withResolvers<void>();
  let footerCount = 0;
  let alternateScreenCount = 0;
  let secondSpoolRemoved = false;
  const fixture = makeLiveRegionFixture((call) => {
    if (call.startsWith("footer:")) {
      footerCount += 1;
      if (footerCount === 2) runningFrame.resolve();
    }
    if (call === "screenMode:alternate-screen") {
      alternateScreenCount += 1;
      if (alternateScreenCount === 1) firstAlternateScreen.resolve();
      if (alternateScreenCount === 2) secondAlternateScreen.resolve();
    }
    if (call.includes("new-after-collapse")) newOutputCommitted.resolve();
  });
  const spoolFactory: LiveRegionSpoolFactory = (() => {
    let spoolCount = 0;
    return () => {
      const spoolIndex = spoolCount;
      spoolCount += 1;
      const lines: string[] = [];
      return {
        append: (line) => {
          lines.push(line);
          if (spoolIndex === 0) firstSpoolAppend.resolve();
          if (spoolIndex === 1) secondSpoolAppend.resolve();
        },
        readLines: async () => {
          if (spoolIndex === 0) {
            firstSpoolRead.resolve();
            await allowFirstSpoolRead.promise;
          }
          return [...lines];
        },
        remove: async () => {
          if (spoolIndex !== 1) return;
          secondSpoolRemove.resolve();
          await allowSecondSpoolRemove.promise;
          secondSpoolRemoved = true;
        },
      };
    };
  })();
  const baseIo = createBufferedRendererIO({ isTTY: true, terminalColumns: 80, terminalRows: 24 });
  let injectInput: ((raw: string) => void) | undefined;
  const io = {
    ...baseIo,
    externalOutputStream: process.stdout,
    subscribeInput: (listener: (raw: string) => void) => {
      injectInput = listener;
      return () => {};
    },
  };
  const transcriptReader = {
    open: (_path: typeof AbsolutePath.Type, _onChange: Effect.Effect<void>) =>
      Effect.acquireRelease(
        Effect.succeed({
          read: () => Effect.succeed({ lines: [] }),
        }),
        () => Effect.void,
      ),
  };

  // When
  const scopeClosed = Effect.runPromise(
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
            parentId: "build",
            label: "web",
            transcriptPath: AbsolutePath.make("/tmp/lando/builds/web.log"),
            timestamp,
          }),
        );
        yield* Effect.promise(() => runningFrame.promise);
        injectInput?.("\r");
        yield* Effect.promise(() => firstAlternateScreen.promise);
        yield* events.publish(
          Schema.decodeUnknownSync(MessageWarnEvent)({
            _tag: "message.warn",
            body: deferredBody("old"),
            timestamp,
          }),
        );
        yield* Effect.promise(() => firstSpoolAppend.promise);

        injectInput?.("\x1b");
        yield* Effect.promise(() => firstSpoolRead.promise);
        yield* events.publish(
          Schema.decodeUnknownSync(MessageWarnEvent)({
            _tag: "message.warn",
            body: "new-after-collapse",
            timestamp,
          }),
        );
        yield* Effect.yieldNow();
        allowFirstSpoolRead.resolve();
        yield* Effect.promise(() => newOutputCommitted.promise);

        injectInput?.("\r");
        yield* Effect.promise(() => secondAlternateScreen.promise);
        yield* events.publish(
          Schema.decodeUnknownSync(MessageWarnEvent)({
            _tag: "message.warn",
            body: deferredBody("dispose"),
            timestamp,
          }),
        );
        yield* Effect.promise(() => secondSpoolAppend.promise);
      }).pipe(
        Effect.provide(
          Layer.provideMerge(
            makeLandoEventConsumer(io, {
              createLiveRegion: (options) =>
                createLiveRegionController(options, {
                  loadModule: async () => fixture.module,
                  createRenderer: async () => fixture.renderer,
                  spool: spoolFactory,
                }),
              transcriptReader,
            }),
            EventServiceLive,
          ),
        ),
      ),
    ),
  );
  await secondSpoolRemove.promise;
  const closedBeforeRemove = await Promise.race([scopeClosed.then(() => true), Promise.resolve(false)]);
  allowSecondSpoolRemove.resolve();
  await scopeClosed;

  // Then
  const oldIndex = fixture.commits.findIndex((line) => line.includes("old-0-"));
  const newIndex = fixture.commits.findIndex((line) => line.includes("new-after-collapse"));
  expect(oldIndex).toBeGreaterThanOrEqual(0);
  expect(newIndex).toBeGreaterThan(oldIndex);
  expect(closedBeforeRemove).toBe(false);
  expect(secondSpoolRemoved).toBe(true);
});
