import { expect, test } from "bun:test";
import * as LandoEventService from "@lando/engine/services/event-service";
import { EventService } from "@lando/sdk/services";
import { DateTime, Effect, Layer } from "effect";
import { createBufferedRendererIO } from "../src/io.ts";
import { layerPlainTaskDetail } from "../src/runtime.ts";

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
