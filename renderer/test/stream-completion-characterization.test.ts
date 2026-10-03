import { describe, expect, test } from "bun:test";
import { StreamFrameSink, type StreamFrameSinkFrame } from "@lando/engine/operations/stream-frame-sink";
import * as LandoEventService from "@lando/engine/services/event-service";
import {
  RedactionService,
  createStandaloneRedactor,
  registerRedactionValues,
} from "@lando/redaction/service";
import { createBufferedRendererIO } from "@lando/renderer/io";
import * as RendererOutput from "@lando/renderer/output";
import * as RendererRuntime from "@lando/renderer/runtime";
import { MessageInfoEvent } from "@lando/sdk/events";
import { EventService } from "@lando/sdk/services";
import { Context, DateTime, Effect, Layer, Stream } from "effect";

const frames = [
  { _tag: "stdout", chunk: "ready", service: "web" },
  { _tag: "stderr", chunk: "warning", service: "web", source: "error-log" },
] satisfies readonly StreamFrameSinkFrame[];
const redaction = Layer.succeed(
  RedactionService,
  RedactionService.of({
    registerValues: registerRedactionValues,
    forProfile: () => Effect.succeed(createStandaloneRedactor("secrets", { sourceEnv: {} })),
  }),
);

describe("renderer finite stream completion", () => {
  for (const bodies of [[], ["queued-one", "queued-two"]]) {
    test(`event renderer closes promptly with ${bodies.length} buffered events`, async () => {
      // Given: a real event subscription and renderer, with a watchdog outside Effect finalization.
      const io = createBufferedRendererIO();
      const layer = RendererRuntime.layerPlain(io).pipe(Layer.provideMerge(LandoEventService.layerWith()));
      const deadline = Promise.withResolvers<"deadline">();
      const timer = setTimeout(() => deadline.resolve("deadline"), 1000);
      try {
        // When: enqueue at scope closure, before the renderer's drain finalizer runs.
        const closed = Effect.runPromise(
          Effect.gen(function* () {
            const context = yield* Layer.build(layer);
            const events = Context.get(context, EventService);
            yield* Effect.addFinalizer(() =>
              Effect.gen(function* () {
                for (const body of bodies) {
                  yield* events.publish(MessageInfoEvent.make({ body, timestamp: DateTime.nowUnsafe() }));
                }
                expect(io.stdout()).toBe("");
              }).pipe(Effect.orDie),
            );
          }).pipe(Effect.scoped),
        ).then(() => "closed");

        // Then: even an empty queue closes promptly; buffered events are rendered in order.
        expect(await Promise.race([closed, deadline.promise])).toBe("closed");
        expect(io.stdout()).toBe(bodies.map((body) => `ℹ ${body}\n`).join(""));
      } finally {
        clearTimeout(timer);
      }
    });
  }

  for (const format of ["json", "text", "yaml"] as const) {
    test(`${format} drains every frame and finalizes before returning`, async () => {
      const io = createBufferedRendererIO();
      let finalized = 0;
      const layer = RendererOutput.layerStreamFrameSink(format).pipe(
        Layer.provide(
          Layer.merge(
            format === "json" ? RendererRuntime.layerJsonService(io) : RendererRuntime.layerPlainService(io),
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
