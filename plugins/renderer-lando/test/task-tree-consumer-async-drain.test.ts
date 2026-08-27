import { expect, test } from "bun:test";
import { Effect, Layer, Schema } from "effect";

import { TaskStartEvent, TaskTreeStartEvent } from "@lando/sdk/events";
import { AbsolutePath } from "@lando/sdk/schema";
import { EventService } from "@lando/sdk/services";

import { EventServiceLive, createBufferedRendererIO } from "@lando/core/testing";
import { createLiveRegionController } from "../src/opentui/live-region-controller.ts";
import type { LiveRegionSpoolFactory } from "../src/opentui/live-region-spool.ts";
import { makeLandoEventConsumer } from "../src/renderer-runtime.ts";
import { createCapturingStdout, makeLiveRegionFixture } from "./live-region-test-kit.ts";

const timestamp = "2026-07-17T12:00:00.000Z";
const deferredBody = (prefix: string): string =>
  Array.from({ length: 3_000 }, (_, index) => `${prefix}-${index}-${"x".repeat(100)}`).join("\n");

test("collapse drains deferred output before later output and scope close awaits spool disposal", async () => {
  // given
  const firstSpoolAppend = Promise.withResolvers<void>();
  const firstSpoolRead = Promise.withResolvers<void>();
  const allowFirstSpoolRead = Promise.withResolvers<void>();
  const secondSpoolAppend = Promise.withResolvers<void>();
  const secondSpoolRemove = Promise.withResolvers<void>();
  const allowSecondSpoolRemove = Promise.withResolvers<void>();
  let secondSpoolRemoved = false;
  const writes: string[] = [];
  const fixture = makeLiveRegionFixture();
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
  const io = {
    ...createBufferedRendererIO({ isTTY: true, terminalColumns: 80, terminalRows: 24 }),
    externalOutputStream: process.stdout,
  };
  let controller: Awaited<ReturnType<typeof createLiveRegionController>> | undefined;

  // when
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
        yield* Effect.promise(() =>
          (async () => {
            for (let attempt = 0; attempt < 400; attempt += 1) {
              if (controller !== undefined && writes.join("").includes("web")) return;
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
            throw new Error("timed out waiting for inline running frame");
          })(),
        );
        const live = controller;
        if (live === undefined) throw new Error("live region controller was not created");
        yield* Effect.promise(() => live.enterFullTail());
        live.commitScrollback(deferredBody("old"));
        yield* Effect.promise(() => firstSpoolAppend.promise);

        const exiting = live.exitFullTail();
        yield* Effect.promise(() => firstSpoolRead.promise);
        live.commitScrollback("new-after-collapse");
        yield* Effect.yieldNow();
        allowFirstSpoolRead.resolve();
        yield* Effect.promise(() => exiting);

        yield* Effect.promise(() => live.enterFullTail());
        live.commitScrollback(deferredBody("dispose"));
        yield* Effect.promise(() => secondSpoolAppend.promise);
      }).pipe(
        Effect.provide(
          Layer.provideMerge(
            makeLandoEventConsumer(io, {
              createLiveRegion: async (options) => {
                const created = await createLiveRegionController(
                  { ...options, stdout: createCapturingStdout(writes) },
                  {
                    loadModule: async () => fixture.module,
                    createRenderer: async () => fixture.renderer,
                    spool: spoolFactory,
                  },
                );
                controller = created;
                return created;
              },
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

  // then
  const output = writes.join("");
  const oldIndex = output.indexOf("old-0-");
  const newIndex = output.indexOf("new-after-collapse");
  expect(oldIndex).toBeGreaterThanOrEqual(0);
  expect(newIndex).toBeGreaterThan(oldIndex);
  expect(closedBeforeRemove).toBe(false);
  expect(secondSpoolRemoved).toBe(true);
});
