import { expect, test } from "bun:test";
import * as LandoEventService from "@lando/engine/services/event-service";
import { EventService } from "@lando/sdk/services";
import { DateTime, Effect, Layer } from "effect";
import { createBufferedRendererIO } from "../src/io.ts";
import {
  layerPlain,
  layerPlainTaskDetail,
  layerVerbose,
  makePlainRenderer,
  makeVerboseRenderer,
} from "../src/runtime.ts";

test.each(["plain", "verbose"] as const)(
  "%s sends events and every message severity to stderr",
  async (mode) => {
    // Given
    const io = createBufferedRendererIO({ isTTY: true });
    const renderer = mode === "plain" ? makePlainRenderer(io) : makeVerboseRenderer(io);
    const consumer = mode === "plain" ? layerPlain(io) : layerVerbose(io);

    // When
    await Effect.runPromise(
      Effect.gen(function* () {
        const events = yield* EventService;
        yield* events.publish({ _tag: "message.info", body: "published", timestamp: DateTime.nowUnsafe() });
        yield* renderer.message.info("information");
        yield* renderer.message.warn("warning");
        yield* renderer.message.error("failure", "fix it");
      }).pipe(Effect.provide(consumer.pipe(Layer.provideMerge(LandoEventService.layer)))),
    );

    // Then
    expect(io.stdout()).toBe("");
    for (const body of ["published", "information", "warning", "failure", "fix it"]) {
      expect(io.stderr()).toContain(body);
    }
  },
);

test("plain detail-only narration leaves stdout empty", async () => {
  // Given
  const io = createBufferedRendererIO();

  // When
  await Effect.runPromise(
    Effect.gen(function* () {
      const events = yield* EventService;
      yield* events.publish({
        _tag: "task.detail",
        taskId: "gen",
        stream: "stdout",
        line: "detail",
        timestamp: DateTime.nowUnsafe(),
      });
    }).pipe(Effect.provide(layerPlainTaskDetail(io).pipe(Layer.provideMerge(LandoEventService.layer)))),
  );

  // Then
  expect(io.stderr()).toBe("[gen] detail\n");
  expect(io.stdout()).toBe("");
});
