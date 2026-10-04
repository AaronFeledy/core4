import { expect, test } from "bun:test";
import { createBufferedRendererIO } from "@lando/renderer/io";
import { Effect, Layer, Tracer } from "effect";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary.ts";

test("CLI composition suppresses host spans while direct host execution keeps tracing enabled", async () => {
  // Given
  const spans: Tracer.NativeSpan[] = [];
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options);
      spans.push(span);
      return span;
    },
  });
  const command = Effect.fn("Command.tracingProbe")(function* () {
    return yield* Effect.succeed("executed");
  });
  const io = createBufferedRendererIO();
  // When
  await runWithRendererHandling(command(), {
    runtime: Layer.succeed(Tracer.Tracer, tracer),
    io,
    rendererMode: "plain",
    resultFormat: "text",
    formatError: String,
    render: (result) => result,
    setExitCode: () => undefined,
  });
  // Then
  expect(io.stdout()).toContain("executed");
  expect(spans).toHaveLength(0);
  await Effect.runPromise(command().pipe(Effect.provideService(Tracer.Tracer, tracer)));
  expect(spans.map((span) => span.name)).toEqual(["Command.tracingProbe"]);
});
