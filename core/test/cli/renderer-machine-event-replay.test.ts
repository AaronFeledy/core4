import { expect, test } from "bun:test";
import * as LandoEventService from "@lando/engine/services/event-service";
import { createBufferedRendererIO, createStdioRendererIO } from "@lando/renderer/io";
import { StreamFrame } from "@lando/sdk/schema";
import { EventService } from "@lando/sdk/services";
import { Effect, Layer, Schema } from "effect";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary";
import { stalledOutput } from "./renderer-stalled-output";

const event = (body: string) => ({
  _tag: "message.info",
  body,
  timestamp: "2026-10-30T00:00:00.000Z",
});
const options = {
  rendererMode: "json",
  resultFormat: "json",
  streamingMode: "live",
  resultSchema: Schema.Struct({}),
  formatError: ({ error }: { readonly error: unknown }) => String(error),
  setExitCode: () => undefined,
} as const;
const decodeFrame = (line: string) => Schema.decodeUnknownSync(StreamFrame)(JSON.parse(line));

test("live JSON retains an event published while history replay is blocked on stdout", async () => {
  // Given
  const output = stalledOutput();
  const acquired = Promise.withResolvers<EventService["Service"]>();
  const runtime = Layer.effectDiscard(
    Effect.gen(function* () {
      const events = yield* EventService;
      yield* events.publish(event("before"));
      acquired.resolve(events);
    }),
  ).pipe(Layer.provideMerge(LandoEventService.layer));
  // When
  const running = runWithRendererHandling(
    Effect.gen(function* () {
      yield* (yield* EventService).publish(event("after-subscribe"));
      return {};
    }),
    { ...options, runtime, io: createStdioRendererIO(output.stream, output.stream) },
  );
  try {
    await output.started;
    await Effect.runPromise((await acquired.promise).publish(event("during-replay")));
    output.release();
    await running;
    // Then
    const frames = output.chunks.map(decodeFrame);
    expect(frames).toMatchObject([
      { _tag: "event", event: "message.info", payload: { body: "before" } },
      { _tag: "event", event: "message.info", payload: { body: "during-replay" } },
      { _tag: "event", event: "message.info", payload: { body: "after-subscribe" } },
      { _tag: "result", envelope: { ok: true } },
    ]);
  } finally {
    output.release();
    await running;
    output.stream.destroy();
  }
});

test.each([false, true])("live JSON dedupes overlap, preserving later repeats (%s)", async (repeat) => {
  // Given: only subscription acquisition is wrapped; delivery and history use the real service.
  const io = createBufferedRendererIO();
  const runtime = Layer.effect(
    EventService,
    Effect.gen(function* () {
      const events = yield* EventService;
      yield* events.publish(event("before"));
      return EventService.of({
        ...events,
        subscribeQueue: events.subscribeQueue.pipe(
          Effect.tap(() => events.publish(event("between-subscribe-and-snapshot")).pipe(Effect.orDie)),
        ),
      });
    }),
  ).pipe(Layer.provide(LandoEventService.layer));
  // When
  await runWithRendererHandling(
    Effect.gen(function* () {
      yield* (yield* EventService).publish(event("after-subscribe"));
      if (repeat) yield* (yield* EventService).publish(event("between-subscribe-and-snapshot"));
      return {};
    }),
    { ...options, runtime, io },
  );
  // Then
  expect(io.stdoutLines().map(decodeFrame)).toMatchObject([
    { _tag: "event", event: "message.info", payload: { body: "before" } },
    { _tag: "event", event: "message.info", payload: { body: "between-subscribe-and-snapshot" } },
    { _tag: "event", event: "message.info", payload: { body: "after-subscribe" } },
    ...(repeat
      ? [{ _tag: "event", event: "message.info", payload: { body: "between-subscribe-and-snapshot" } }]
      : []),
    { _tag: "result", envelope: { ok: true } },
  ]);
  expect(io.stderr()).toBe("");
});
