import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";

import { StreamFrameSink } from "@lando/engine/operations/stream-frame-sink";
import { RedactionService, createStandaloneRedactor } from "@lando/redaction/service";

import { createBufferedRendererIO } from "../src/io";
import { makeStreamFrameSinkLive } from "../src/output";
import { makePlainRendererServiceLive } from "../src/runtime";

const identityRedaction = Layer.succeed(RedactionService, {
  forProfile: () => Effect.succeed(createStandaloneRedactor("secrets", { sourceEnv: {} })),
});

describe("makeStreamFrameSinkLive raw frames", () => {
  test("writes a raw stdout chunk without adding a newline or service prefix", async () => {
    // Given: a plain stream sink and a progress-style chunk that already includes a carriage return.
    const io = createBufferedRendererIO();
    const layer = makeStreamFrameSinkLive("text").pipe(
      Layer.provide(Layer.merge(makePlainRendererServiceLive(io), identityRedaction)),
    );

    // When: tooling emits a raw stdout frame.
    await Effect.runPromise(
      Effect.gen(function* () {
        const sink = yield* StreamFrameSink;
        yield* sink.emit({ _tag: "stdout", chunk: "Downloading 12%\r", raw: true });
      }).pipe(Effect.provide(layer)),
    );

    // Then: the renderer writes the chunk verbatim.
    expect(io.stdout()).toBe("Downloading 12%\r");
  });

  test("writes a raw stderr chunk to stderr without adding a newline", async () => {
    const io = createBufferedRendererIO();
    const layer = makeStreamFrameSinkLive("text").pipe(
      Layer.provide(Layer.merge(makePlainRendererServiceLive(io), identityRedaction)),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const sink = yield* StreamFrameSink;
        yield* sink.emit({ _tag: "stderr", chunk: "warning: lock\n", raw: true });
      }).pipe(Effect.provide(layer)),
    );

    expect(io.stderr()).toBe("warning: lock\n");
    expect(io.stdout()).toBe("");
  });
});
