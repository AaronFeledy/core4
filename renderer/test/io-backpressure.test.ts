import { expect, test } from "bun:test";
import { Socket } from "node:net";
import { Effect, Exit, Fiber, Stream } from "effect";
import { createStdioRendererIO } from "../src/io.ts";
import { makeJsonRenderer, makePlainRenderer, makeVerboseRenderer } from "../src/runtime.ts";

const stalledStream = () => {
  const started = Promise.withResolvers<void>();
  let accept = false;
  let release: (() => void) | undefined;
  const stream = Object.assign(new Socket(), {
    _write: (_chunk: Uint8Array, _encoding: BufferEncoding, callback: (error?: Error | null) => void) => {
      started.resolve();
      if (accept) callback();
      else release = callback;
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
  return {
    stream,
    started: started.promise,
    open: () => {
      accept = true;
      release?.();
    },
  };
};

for (const makeRenderer of [makePlainRenderer, makeJsonRenderer, makeVerboseRenderer]) {
  for (const channel of ["stdout", "stderr"] as const) {
    test(`${makeRenderer.name} ${channel} pauses a producer at one chunk until drain`, async () => {
      // Given
      const target = stalledStream();
      const io = createStdioRendererIO(target.stream, target.stream);
      const output = makeRenderer(io).output[channel];
      const chunk = new Uint8Array(65536);
      let produced = 0;
      try {
        // When
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const fiber = yield* Effect.forkScoped(
                Stream.fromEffectRepeat(
                  Effect.sync(() => {
                    produced += 1;
                    return chunk;
                  }),
                ).pipe(Stream.take(256), Stream.runForEach(output)),
              );
              yield* Effect.promise(() => target.started);
              yield* Effect.yieldNow;
              // Then
              expect(produced).toBe(1);
              expect(target.stream.writableLength).toBe(65536);
              target.open();
              yield* Fiber.join(fiber);
              expect(produced).toBe(256);
              expect(target.stream.writableLength).toBe(0);
              expect(target.stream.listenerCount("drain")).toBe(0);
            }),
          ),
        );
      } finally {
        target.stream.destroy();
      }
    });
  }
}

for (const end of ["close", "EPIPE", "error", "interrupt"] as const) {
  test(`a pending drain finishes and removes listeners on ${end}`, async () => {
    // Given
    const target = stalledStream();
    const renderer = makePlainRenderer(createStdioRendererIO(target.stream, target.stream));
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const fiber = yield* Effect.forkScoped(renderer.output.stdout(new Uint8Array(65536)));
            yield* Effect.promise(() => target.started);
            yield* Effect.yieldNow;
            // When
            if (end === "close") target.stream.destroy();
            else if (end === "interrupt") yield* Fiber.interrupt(fiber);
            else
              target.stream.emit(
                "error",
                Object.assign(new Error(end), { code: end === "EPIPE" ? "EPIPE" : "EIO" }),
              );
            const exit = yield* Fiber.await(fiber);
            // Then
            expect(Exit.isFailure(exit)).toBe(end === "error" || end === "interrupt");
            expect(target.stream.listenerCount("drain")).toBe(0);
            expect(target.stream.listenerCount("error")).toBe(1);
          }),
        ),
      );
    } finally {
      target.stream.destroy();
    }
  });
}
