import { describe, expect, test } from "bun:test";
import { StreamFrameSink, type StreamFrameSinkFrame } from "@lando/engine/operations/stream-frame-sink";
import {
  RedactionService,
  createStandaloneRedactor,
  registerRedactionValues,
} from "@lando/redaction/service";
import { createBufferedRendererIO } from "@lando/renderer/io";
import { makeStreamFrameSinkLive } from "@lando/renderer/output";
import { makeJsonRendererServiceLive, makePlainRendererServiceLive } from "@lando/renderer/runtime";
import { Effect, Layer, Stream } from "effect";

const frames = [
  { _tag: "stdout", chunk: "ready", service: "web" },
  { _tag: "stderr", chunk: "warning", service: "web", source: "error-log" },
] satisfies readonly StreamFrameSinkFrame[];
const redaction = Layer.succeed(RedactionService, {
  registerValues: registerRedactionValues,
  forProfile: () => Effect.succeed(createStandaloneRedactor("secrets", { sourceEnv: {} })),
});

describe("renderer finite stream completion", () => {
  for (const format of ["json", "text", "yaml"] as const) {
    test(`${format} drains every frame and finalizes before returning`, async () => {
      const io = createBufferedRendererIO();
      let finalized = 0;
      const layer = makeStreamFrameSinkLive(format).pipe(
        Layer.provide(
          Layer.merge(
            format === "json" ? makeJsonRendererServiceLive(io) : makePlainRendererServiceLive(io),
            redaction,
          ),
        ),
      );
      const stream = Stream.fromIterable(frames).pipe(
        Stream.ensuring(
          Effect.sync(() => {
            finalized += 1;
          }),
        ),
      );

      await Effect.runPromise(
        Effect.gen(function* () {
          const sink = yield* StreamFrameSink;
          yield* Stream.runForEach(stream, sink.emit);
        }).pipe(Effect.provide(layer)),
      );

      expect(finalized).toBe(1);
      expect(io.stderr()).toBe("");
      if (format === "json") {
        expect(
          io
            .stdout()
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line)),
        ).toEqual([
          { _tag: "stdout", chunk: "ready", service: "web" },
          { _tag: "stderr", chunk: "warning", service: "web", source: "error-log" },
        ]);
      } else {
        expect(io.stdout()).toBe(
          format === "yaml" ? "" : "web stdout: ready\nweb stderr [error-log]: warning\n",
        );
      }
    });
  }
});
