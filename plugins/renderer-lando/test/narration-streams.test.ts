import { expect, test } from "bun:test";
import * as LandoEventService from "@lando/engine/services/event-service";
import { createBufferedRendererIO } from "@lando/renderer/io";
import { EventService, Renderer } from "@lando/sdk/services";
import { DateTime, Effect, Layer } from "effect";
import { makeLandoEventConsumer, makeLandoService } from "../src/renderer-runtime.ts";

test.each(["alpha\nbeta\n", "no-newline"])(
  "keeps tooling payload %j separate from non-TTY narration",
  async (payload) => {
    // Given
    const io = createBufferedRendererIO({ isTTY: false });
    const timestamp = DateTime.nowUnsafe();
    const layer = Layer.merge(makeLandoService(io), makeLandoEventConsumer(io)).pipe(
      Layer.provideMerge(LandoEventService.layer),
    );

    // When
    await Effect.runPromise(
      Effect.gen(function* () {
        const events = yield* EventService;
        const renderer = yield* Renderer;
        yield* events.publish({
          _tag: "task.tree.start",
          parentId: "tooling:gen",
          label: "gen",
          children: ["tooling:gen:exec"],
          timestamp,
        });
        yield* events.publish({
          _tag: "task.start",
          taskId: "tooling:gen:exec",
          parentId: "tooling:gen",
          label: "executing",
          timestamp,
        });
        yield* renderer.output.stdout(payload);
        yield* events.publish({ _tag: "task.complete", taskId: "tooling:gen:exec", timestamp });
        yield* events.publish({
          _tag: "task.tree.complete",
          parentId: "tooling:gen",
          succeeded: 1,
          failed: 0,
          timestamp,
        });
      }).pipe(Effect.provide(layer)),
    );

    // Then
    expect(io.stdout()).toBe(payload);
    expect(io.stderrLines()).toEqual([
      "▼ gen (1 step)",
      "[tooling:gen:exec] start: executing",
      "[tooling:gen:exec] ✓ complete",
      "▶ complete (1 ✓ · 0 ✗)",
    ]);
  },
);
