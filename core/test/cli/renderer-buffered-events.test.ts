import { expect, test } from "bun:test";
import { StreamFrameSink } from "@lando/engine/operations/stream-frame-sink";
import * as LandoEventService from "@lando/engine/services/event-service";
import { createBufferedRendererIO, createStdioRendererIO } from "@lando/renderer/io";
import {
  BeforeExitEvent,
  MessageWarnEvent,
  PostBootstrapAppEvent,
  PostBootstrapCommandsEvent,
  PostBootstrapEvent,
  PostBootstrapMinimalEvent,
  PostBootstrapPluginsEvent,
  PostBootstrapProviderEvent,
  PostBootstrapToolingEvent,
  PreBootstrapAppEvent,
  PreBootstrapCommandsEvent,
  PreBootstrapMinimalEvent,
  PreBootstrapPluginsEvent,
  PreBootstrapProviderEvent,
  PreBootstrapToolingEvent,
  ReadyEvent,
} from "@lando/sdk/events";
import { StreamFrame } from "@lando/sdk/schema";
import { EventService } from "@lando/sdk/services";
import { DateTime, Effect, Layer, Option, Schema } from "effect";
import { finishCommandProgress } from "../../src/cli/command-progress";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary";
import { stalledOutput } from "./renderer-stalled-output";

const event = (body: string) => ({ _tag: "message.info", body, timestamp: "2026-10-30T00:00:00.000Z" });
const decodeFrame = (line: string) => Schema.decodeUnknownSync(StreamFrame)(JSON.parse(line));
const options = {
  runtime: Layer.empty,
  rendererMode: "json",
  resultFormat: "json",
  command: "app:start",
  streaming: StreamFrame,
  resultSchema: Schema.Struct({}),
  formatError: ({ error }: { readonly error: unknown }) => String(error),
  setExitCode: () => undefined,
} as const;

test("buffered start delivers 200 events before completion, then lifecycle, data and result", async () => {
  // Given
  const io = createBufferedRendererIO();
  const delivered = Promise.withResolvers<void>();
  let completed = false;
  let deliveredLive = false;
  const output = {
    ...io,
    writeStdout: (chunk: string | Uint8Array) => {
      io.writeStdout(chunk);
      if (typeof chunk === "string" && chunk.includes('"body":"event 199"')) {
        deliveredLive = !completed;
        delivered.resolve();
      }
    },
  };
  // When
  await runWithRendererHandling(
    Effect.gen(function* () {
      const events = yield* EventService;
      yield* finishCommandProgress();
      yield* Effect.addFinalizer(() => events.publish(event("producer-finished")).pipe(Effect.orDie));
      for (let index = 0; index < 200; index++) yield* events.publish(event(`event ${index}`));
      yield* Effect.promise(() => delivered.promise);
      completed = true;
      return {};
    }).pipe(Effect.scoped),
    {
      ...options,
      io: output,
      signal: AbortSignal.timeout(2000),
      invocation: { commandId: "app:start", argv: [], args: {}, flags: {}, cwd: process.cwd() },
      streamFrames: () => [{ _tag: "stdout", chunk: "buffered data" }],
    },
  );
  // Then
  const frames = io.stdoutLines().map(decodeFrame);
  expect(deliveredLive).toBe(true);
  expect(
    frames
      .filter((frame) => frame._tag === "event")
      .filter((frame) => frame.event === "message.info")
      .map((frame) => frame.payload),
  ).toEqual([
    ...Array.from({ length: 200 }, (_, index) => event(`event ${index}`)),
    event("producer-finished"),
  ]);
  expect(frames.slice(-3)).toMatchObject([
    { _tag: "event", event: "cli-app:start-run" },
    { _tag: "stdout", chunk: "buffered data" },
    { _tag: "result", envelope: { ok: true, warnings: [] } },
  ]);
});

test.each([
  [false, false],
  [false, true],
  [true, false],
  [true, true],
] as const)("frame retirement reports the exact drop count (failure=%s, live=%s)", async (failure, live) => {
  // Given
  const output = stalledOutput();
  const published = Promise.withResolvers<void>();
  const running = runWithRendererHandling(
    Effect.gen(function* () {
      const events = yield* EventService;
      yield* events.publish(event("in-flight"));
      yield* Effect.promise(() => output.started);
      for (let index = 0; index < 1500; index++) yield* events.publish(event(`queued ${index}`));
      published.resolve();
      if (failure) return yield* Effect.fail("boom");
      return {};
    }),
    {
      ...options,
      ...(live ? { streamingMode: "live" } : {}),
      io: createStdioRendererIO(output.stream, output.stream),
    },
  );
  // When
  try {
    await published.promise;
    expect(output.chunks).toHaveLength(1);
    output.release();
    await running;
    // Then
    const frames = output.chunks.map(decodeFrame);
    expect(frames.filter((frame) => frame._tag === "event")).toHaveLength(1025);
    expect(frames.at(-1)).toMatchObject({
      _tag: "result",
      envelope: {
        ok: !failure,
        warnings: [
          {
            code: "LANDO_EVENT_FRAMES_DROPPED",
            message: "476 events were dropped because the output reader fell behind.",
          },
        ],
      },
    });
    expect(frames.filter((frame) => frame._tag === "result")).toHaveLength(1);
  } finally {
    output.release();
    await running;
    output.stream.destroy();
  }
});

test.each([false, true])(
  "live sink flushes producer tails before terminal lifecycle (failure=%s)",
  async (failure) => {
    // Given
    const io = createBufferedRendererIO();
    // When
    await runWithRendererHandling(
      Effect.gen(function* () {
        const sink = Option.getOrThrow(yield* Effect.serviceOption(StreamFrameSink));
        yield* Effect.addFinalizer(() => sink.emit({ _tag: "stdout", kind: "bytes", chunk: "tail" }));
        yield* sink.emit({ _tag: "stdout", kind: "bytes", chunk: "head" });
        if (failure) return yield* Effect.fail("boom");
        return {};
      }).pipe(Effect.scoped),
      {
        ...options,
        io,
        streamingMode: "live",
        invocation: { commandId: "app:start", argv: [], args: {}, flags: {}, cwd: process.cwd() },
      },
    );
    // Then
    const frames = io.stdoutLines().map(decodeFrame);
    expect(frames.filter((frame) => frame._tag === "stdout")).toEqual([
      { _tag: "stdout", chunk: "headtail" },
    ]);
    expect(frames.filter((frame) => frame._tag === "event").map((frame) => frame.event)).toEqual([
      "cli-app:start-init",
      failure ? "cli-app:start-error" : "cli-app:start-run",
    ]);
    expect(frames.slice(-2)).toMatchObject([
      { _tag: "event", event: failure ? "cli-app:start-error" : "cli-app:start-run" },
      { _tag: "result", envelope: { ok: !failure } },
    ]);
  },
);

test.each([false, true])(
  "frames omit only bootstrap markers and retain bootstrap warnings (live=%s)",
  async (live) => {
    // Given
    const io = createBufferedRendererIO();
    const runtime = Layer.effectDiscard(
      Effect.gen(function* () {
        const events = yield* EventService;
        for (const marker of [
          PreBootstrapMinimalEvent,
          PostBootstrapMinimalEvent,
          PreBootstrapPluginsEvent,
          PostBootstrapPluginsEvent,
          PreBootstrapCommandsEvent,
          PostBootstrapCommandsEvent,
          PreBootstrapProviderEvent,
          PostBootstrapProviderEvent,
          PreBootstrapAppEvent,
          PostBootstrapAppEvent,
          PreBootstrapToolingEvent,
          PostBootstrapToolingEvent,
          PostBootstrapEvent,
          ReadyEvent,
        ]) {
          yield* events.publish(marker.make({ timestamp: DateTime.nowUnsafe() }));
        }
        yield* events.publish(
          MessageWarnEvent.make({ body: "bootstrap warning", timestamp: DateTime.nowUnsafe() }),
        );
        yield* events.publish(BeforeExitEvent.make({ exitCode: 0, timestamp: DateTime.nowUnsafe() }));
      }),
    ).pipe(Layer.provideMerge(LandoEventService.layer));
    // When
    await runWithRendererHandling(Effect.succeed({}), {
      ...options,
      runtime,
      io,
      ...(live ? { streamingMode: "live" } : {}),
    });
    // Then
    const frames = io.stdoutLines().map(decodeFrame);
    expect(frames.filter((frame) => frame._tag === "event").map((frame) => frame.event)).toEqual([
      "message.warn",
      "before-exit",
    ]);
    expect(frames.at(-1)).toMatchObject({
      _tag: "result",
      envelope: {
        warnings: [{ code: "LANDO_MESSAGE_WARN", message: "bootstrap warning" }],
      },
    });
  },
);

test.each([false, true])(
  "failure lifecycle and producer finalizers precede the terminal frame (live=%s)",
  async (live) => {
    // Given
    const io = createBufferedRendererIO();
    // When
    await runWithRendererHandling(
      Effect.gen(function* () {
        const events = yield* EventService;
        yield* Effect.addFinalizer(() => events.publish(event("producer-finished")).pipe(Effect.orDie));
        yield* events.publish(event("before-failure"));
        return yield* Effect.fail("boom");
      }).pipe(Effect.scoped),
      {
        ...options,
        io,
        ...(live ? { streamingMode: "live" } : {}),
        invocation: { commandId: "app:start", argv: [], args: {}, flags: {}, cwd: process.cwd() },
      },
    );
    // Then
    expect(io.stdoutLines().map(decodeFrame)).toMatchObject([
      { _tag: "event", event: "cli-app:start-init" },
      { _tag: "event", payload: { body: "before-failure" } },
      { _tag: "event", payload: { body: "producer-finished" } },
      { _tag: "event", event: "cli-app:start-error" },
      { _tag: "result", envelope: { ok: false } },
    ]);
  },
);
