import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";

import {
  RedactionService,
  createStandaloneRedactor,
  registerRedactionValues,
} from "@lando/redaction/service";
import { createBufferedRendererIO } from "@lando/renderer/io";
import * as RendererOutput from "@lando/renderer/output";
import * as RendererRuntime from "@lando/renderer/runtime";

import { StreamFrameSink } from "../src/operations/stream-frame-sink";

const identityRedaction = Layer.succeed(
  RedactionService,
  RedactionService.of({
    registerValues: registerRedactionValues,
    forProfile: () => Effect.succeed(createStandaloneRedactor("secrets", { sourceEnv: {} })),
  }),
);

describe("RendererOutput.layerStreamFrameSink raw frames", () => {
  test("writes a raw stdout chunk without adding a newline or service prefix", async () => {
    // Given: a plain stream sink and a progress-style chunk that already includes a carriage return.
    const io = createBufferedRendererIO();
    const layer = RendererOutput.layerStreamFrameSink("text").pipe(
      Layer.provide(Layer.merge(RendererRuntime.layerPlainService(io), identityRedaction)),
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
    const layer = RendererOutput.layerStreamFrameSink("text").pipe(
      Layer.provide(Layer.merge(RendererRuntime.layerPlainService(io), identityRedaction)),
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
