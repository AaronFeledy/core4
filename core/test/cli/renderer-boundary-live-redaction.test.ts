import { expect, test } from "bun:test";
import { StreamFrameSink } from "@lando/engine/operations/stream-frame-sink";
import { RedactionService } from "@lando/redaction/service";
import { createBufferedRendererIO } from "@lando/renderer/io";
import { SecretStore } from "@lando/sdk/services";
import { Effect, Layer, Schema } from "effect";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary.ts";

for (const format of ["text", "json"] as const) {
  test(`live ${format} payload masks secrets from the command runtime store`, async () => {
    // Given
    const canary = "runtime-store-canary-4582";
    const store = Layer.succeed(SecretStore, {
      id: "custom-store",
      get: () => Effect.succeed(canary),
      has: () => Effect.succeed(true),
      list: Effect.succeed(["canary"]),
    });
    const io = createBufferedRendererIO();
    // When
    await runWithRendererHandling(
      Effect.gen(function* () {
        const sink = yield* StreamFrameSink;
        yield* sink.emit({ _tag: "stdout", chunk: canary.slice(0, 9), raw: true });
        yield* sink.emit({ _tag: "stdout", chunk: `${canary.slice(9)}!\n`, raw: true });
        if (sink.flush !== undefined) yield* sink.flush();
        return {};
      }),
      {
        runtime: RedactionService.layer.pipe(Layer.provide(store)),
        rendererMode: "plain",
        resultFormat: format,
        resultSchema: Schema.Struct({}),
        streamingMode: "live",
        io,
        formatError: String,
        setExitCode: () => undefined,
      },
    );
    // Then
    expect(io.stdout()).not.toContain(canary);
    expect(io.stdout()).toContain("[redacted]!");
  });
}
