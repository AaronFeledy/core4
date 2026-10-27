import { expect, test } from "bun:test";
import { StreamFrameSink } from "@lando/engine/operations/stream-frame-sink";
import * as EnvironmentValueResolverLayer from "@lando/engine/services/environment-value-resolver";
import { RedactionService } from "@lando/redaction/service";
import { createBufferedRendererIO } from "@lando/renderer/io";
import { EnvironmentValueResolver, SecretStore } from "@lando/sdk/services";
import { Effect, Layer, Option, Schema } from "effect";
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
        const session = yield* (yield* EnvironmentValueResolver).openSession();
        yield* session.resolveEnvironment({ VALUE: { _tag: "SecretRef", reference: "canary" } });
        const sink = yield* Effect.serviceOption(StreamFrameSink);
        if (Option.isSome(sink)) {
          yield* sink.value.emit({ _tag: "stdout", chunk: canary.slice(0, 9), kind: "bytes" });
          yield* sink.value.emit({ _tag: "stdout", chunk: `${canary.slice(9)}!\n`, kind: "bytes" });
        }
        return { output: Option.isSome(sink) ? "" : `${canary}!\n` };
      }).pipe(Effect.scoped),
      {
        runtime: Layer.mergeAll(
          RedactionService.layer,
          EnvironmentValueResolverLayer.layer.pipe(Layer.provide(Layer.merge(store, RedactionService.layer))),
        ),
        rendererMode: "plain",
        resultFormat: format,
        resultSchema: Schema.Struct({ output: Schema.String }),
        streamingMode: "live",
        io,
        formatError: ({ error }) => String(error),
        setExitCode: () => undefined,
      },
    );
    // Then
    expect(io.stdout()).not.toContain(canary);
    expect(io.stdout()).toContain("[redacted]!");
  });
}
