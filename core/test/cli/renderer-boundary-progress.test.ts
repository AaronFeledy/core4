import { expect, test } from "bun:test";
import { createBufferedRendererIO } from "@lando/renderer/io";
import { EventService, Renderer } from "@lando/sdk/services";
import { Effect, Layer } from "effect";
import { finishCommandProgress } from "../../src/cli/command-progress.ts";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary.ts";

test.each(["lando", "plain", "verbose"] as const)(
  "%s progress retires independently and idempotently",
  async (rendererMode) => {
    // Given
    const io = createBufferedRendererIO();
    let runtimeOpen = false;
    let continued = false;
    const runtime = Layer.effectDiscard(
      Effect.acquireRelease(
        Effect.sync(() => {
          runtimeOpen = true;
        }),
        () =>
          Effect.sync(() => {
            runtimeOpen = false;
          }),
      ),
    );
    const prompt = "prompt> \x1b[2K";
    // When
    await runWithRendererHandling(
      Effect.gen(function* () {
        const events = yield* EventService;
        const renderer = yield* Renderer;
        yield* events.publish({
          _tag: "message.info",
          body: "before-retirement",
          timestamp: "2026-10-13T00:00:00Z",
        });
        yield* finishCommandProgress();
        expect(io.stdout()).toContain("before-retirement");
        expect(runtimeOpen).toBe(true);
        yield* finishCommandProgress();
        const before = io.stdout();
        yield* renderer.output.stdout(prompt);
        expect(io.stdout().slice(before.length)).toBe(prompt);
        yield* events.publish({
          _tag: "message.info",
          body: "after-retirement",
          timestamp: "2026-10-13T00:00:00Z",
        });
        continued = true;
        return "done";
      }),
      { runtime, rendererMode, io, render: (value) => value, formatError: String, setExitCode: () => {} },
    );
    // Then
    expect(continued).toBe(true);
    expect(runtimeOpen).toBe(false);
    expect(io.stdout()).not.toContain("after-retirement");
    expect(io.stdout().endsWith(`${prompt}done\n`)).toBe(true);
    expect(io.stderr()).toBe("");
  },
);

test("progress still drains at command end when no early retirement is requested", async () => {
  // Given
  const io = createBufferedRendererIO();
  // When
  await runWithRendererHandling(
    Effect.gen(function* () {
      const events = yield* EventService;
      yield* events.publish({
        _tag: "message.info",
        body: "queued-at-exit",
        timestamp: "2026-10-13T00:00:00Z",
      });
      return "done";
    }),
    {
      runtime: Layer.empty,
      rendererMode: "plain",
      io,
      render: (value) => value,
      formatError: String,
      setExitCode: () => {},
    },
  );
  // Then
  expect(io.stdout()).toBe("ℹ queued-at-exit\ndone\n");
});
