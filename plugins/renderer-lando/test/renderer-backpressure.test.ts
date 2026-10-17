import { expect, test } from "bun:test";
import { Socket } from "node:net";
import { createStdioRendererIO } from "@lando/renderer/io";
import { RENDERER_CAPABILITIES_NONE } from "@lando/sdk/renderer";
import { Renderer } from "@lando/sdk/services";
import { Effect, Fiber } from "effect";
import { makeLandoService } from "../src/renderer-service.ts";

for (const channel of ["stdout", "stderr"] as const) {
  test(`lando ${channel} output waits for the writable to drain`, async () => {
    // Given
    const started = Promise.withResolvers<void>();
    let release: (() => void) | undefined;
    const stream = Object.assign(new Socket(), {
      _write: (_chunk: Uint8Array, _encoding: BufferEncoding, callback: (error?: Error | null) => void) => {
        release = callback;
        started.resolve();
      },
      isTTY: false,
      columns: 80,
      rows: 24,
      clearLine: () => true,
      clearScreenDown: () => true,
      cursorTo: () => true,
      moveCursor: () => true,
      getWindowSize: (): [number, number] => [80, 24],
      getColorDepth: () => 1,
      hasColors: () => false,
    });
    const io = createStdioRendererIO(stream, stream);
    let finished = false;
    try {
      // When
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const renderer = yield* Renderer;
            const fiber = yield* Effect.forkScoped(
              renderer.output[channel](new Uint8Array(65536)).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    finished = true;
                  }),
                ),
              ),
            );
            yield* Effect.promise(() => started.promise);
            yield* Effect.yieldNow;
            // Then
            expect(finished).toBe(false);
            expect(stream.writableLength).toBe(65536);
            release?.();
            yield* Fiber.join(fiber);
            expect(finished).toBe(true);
            expect(stream.writableLength).toBe(0);
          }),
        ).pipe(Effect.provide(makeLandoService(io, () => RENDERER_CAPABILITIES_NONE))),
      );
    } finally {
      stream.destroy();
    }
  });
}
