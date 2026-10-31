import { expect, test } from "bun:test";
import { StreamFrameSink } from "@lando/engine/operations/stream-frame-sink";
import * as LandoEventService from "@lando/engine/services/event-service";
import { createBufferedRendererIO } from "@lando/renderer/io";
import { StreamFrame } from "@lando/sdk/schema";
import { EventService } from "@lando/sdk/services";
import { Effect, Layer, Option, Schema } from "effect";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary";

const timestamp = "2026-10-30T00:00:00.000Z";
const decodeFrame = (line: string) => Schema.decodeUnknownSync(StreamFrame)(JSON.parse(line));
const decodeFrames = (output: string) => output.trim().split("\n").map(decodeFrame);
const emitOutput = Effect.fnUntraced(function* () {
  const sink = yield* Effect.serviceOption(StreamFrameSink);
  if (Option.isNone(sink)) throw new Error("expected live sink");
  yield* sink.value.emit({ _tag: "stdout", kind: "bytes", chunk: "out\n" });
});
const options = {
  runtime: Layer.empty,
  rendererMode: "json",
  resultFormat: "json",
  command: "app:exec",
  streamingMode: "live",
  resultSchema: Schema.Struct({}),
  formatError: ({ error }: { readonly error: unknown }) => String(error),
  setExitCode: () => undefined,
} as const;

test("live JSON frames published messages in order and retains warnings in the last result", async () => {
  // Given
  const io = createBufferedRendererIO();
  // When
  await runWithRendererHandling(
    Effect.gen(function* () {
      const events = yield* EventService;
      yield* events.publish({ _tag: "message.info", body: "starting", timestamp });
      yield* emitOutput();
      yield* events.publish({ _tag: "message.warn", body: "check this", timestamp });
      return {};
    }),
    { ...options, io },
  );
  // Then: data may interleave, but events retain publication order and result is last.
  const frames = decodeFrames(io.stdout());
  expect(frames.filter((frame) => frame._tag === "event").map((frame) => frame.event)).toEqual([
    "message.info",
    "message.warn",
  ]);
  expect(frames.filter((frame) => frame._tag === "stdout")).toEqual([{ _tag: "stdout", chunk: "out\n" }]);
  expect(frames.filter((frame) => frame._tag === "result")).toHaveLength(1);
  expect(frames.at(-1)).toMatchObject({
    _tag: "result",
    envelope: { ok: true, warnings: [{ code: "LANDO_MESSAGE_WARN", message: "check this" }] },
  });
  expect(io.stderr()).toBe("");
});

test("live JSON replays runtime history before data and frames command lifecycle events", async () => {
  // Given: publication happens during runtime construction, before the consumer exists.
  const io = createBufferedRendererIO();
  const runtime = Layer.effectDiscard(
    Effect.gen(function* () {
      yield* (yield* EventService).publish({ _tag: "message.info", body: "bootstrap", timestamp });
    }),
  ).pipe(Layer.provideMerge(LandoEventService.layer));
  // When
  await runWithRendererHandling(
    Effect.gen(function* () {
      yield* emitOutput();
      return {};
    }),
    {
      ...options,
      runtime,
      io,
      invocation: { commandId: "app:exec", argv: [], args: {}, flags: {}, cwd: process.cwd() },
    },
  );
  // Then
  const frames = decodeFrames(io.stdout());
  expect(frames[0]).toMatchObject({ _tag: "event", event: "message.info", payload: { body: "bootstrap" } });
  expect(frames.filter((frame) => frame._tag === "event").map((frame) => frame.event)).toEqual([
    "message.info",
    "cli-app:exec-init",
    "cli-app:exec-run",
  ]);
  expect(frames.filter((frame) => frame._tag !== "event").map((frame) => frame._tag)).toEqual([
    "stdout",
    "result",
  ]);
  expect(frames.at(-1)?._tag).toBe("result");
  expect(io.stderr()).toBe("");
});

test("live JSON drains published events before a failed terminal result", async () => {
  // Given
  const io = createBufferedRendererIO();
  const exitCodes: number[] = [];
  // When
  await runWithRendererHandling(
    Effect.gen(function* () {
      yield* (yield* EventService).publish({ _tag: "message.info", body: "before failure", timestamp });
      return yield* Effect.fail("boom");
    }),
    {
      ...options,
      io,
      setExitCode: (code) => {
        exitCodes.push(code);
      },
    },
  );
  // Then
  const frames = decodeFrames(io.stdout());
  expect(frames.map((frame) => frame._tag)).toEqual(["event", "result"]);
  expect(frames[0]).toMatchObject({ _tag: "event", event: "message.info" });
  expect(frames.at(-1)).toMatchObject({ _tag: "result", envelope: { ok: false } });
  expect(exitCodes).toEqual([1]);
  expect(io.stderr()).toBe("");
});

test("live JSON frames a desktop notification once without stderr narration", async () => {
  // Given
  const io = createBufferedRendererIO();
  // When
  await runWithRendererHandling(
    Effect.gen(function* () {
      yield* (yield* EventService).publish({ _tag: "notify.desktop", title: "Done", urgency: "success" });
      return {};
    }),
    { ...options, io },
  );
  // Then
  const frames = decodeFrames(io.stdout());
  expect(frames.map((frame) => frame._tag)).toEqual(["event", "result"]);
  expect(frames[0]).toMatchObject({ _tag: "event", event: "notify.desktop", payload: { title: "Done" } });
  expect(io.stderr()).toBe("");
});

test("live JSON drains the event published immediately before completion", async () => {
  // Given
  const io = createBufferedRendererIO();
  // When
  await runWithRendererHandling(
    Effect.gen(function* () {
      yield* (yield* EventService).publish({ _tag: "message.info", body: "last event", timestamp });
      return {};
    }),
    { ...options, io },
  );
  // Then
  expect(decodeFrames(io.stdout())).toMatchObject([
    { _tag: "event", event: "message.info", payload: { body: "last event" } },
    { _tag: "result", envelope: { ok: true } },
  ]);
});

test("live and buffered JSON event frames have identical redacted bytes", async () => {
  // Given
  const outputs: string[] = [];
  const secret = "event-frame-parity-canary";
  const { streamingMode: _live, ...baseOptions } = options;
  // When
  for (const streamingMode of [undefined, "live"] as const) {
    const io = createBufferedRendererIO();
    await runWithRendererHandling(
      Effect.gen(function* () {
        yield* (yield* EventService).publish({ _tag: "message.info", body: secret, timestamp });
        return {};
      }),
      {
        ...baseOptions,
        ...(streamingMode === undefined ? {} : { streamingMode }),
        streaming: StreamFrame,
        extraRedactionTokens: [secret],
        sourceEnv: {},
        io,
      },
    );
    outputs.push(io.stdout());
  }
  // Then
  expect(outputs[1]).toBe(outputs[0]);
  expect(outputs[1]).toContain("[redacted]");
  expect(outputs[1]).not.toContain(secret);
});

test("live JSON applies jq only to the terminal envelope, not event or data frames", async () => {
  // Given
  const io = createBufferedRendererIO();
  // When
  await runWithRendererHandling(
    Effect.gen(function* () {
      yield* (yield* EventService).publish({ _tag: "message.info", body: "starting", timestamp });
      yield* emitOutput();
      return {};
    }),
    { ...options, jqExpression: ".ok", io },
  );
  // Then
  const lines = io.stdoutLines();
  expect(lines.at(-1)).toBe("true");
  const frames = lines.slice(0, -1).map(decodeFrame);
  expect(frames.filter((frame) => frame._tag === "event")).toMatchObject([
    { _tag: "event", event: "message.info", payload: { body: "starting" } },
  ]);
  expect(frames.filter((frame) => frame._tag === "stdout")).toEqual([{ _tag: "stdout", chunk: "out\n" }]);
  expect(io.stderr()).toBe("");
});

test("live event delivery does not flush a held partial data line", async () => {
  // Given
  const io = createBufferedRendererIO();
  // When
  await runWithRendererHandling(
    Effect.gen(function* () {
      const sink = yield* Effect.serviceOption(StreamFrameSink);
      if (Option.isNone(sink)) throw new Error("expected live sink");
      yield* sink.value.emit({ _tag: "stdout", kind: "bytes", chunk: "prefix" });
      yield* (yield* EventService).publish({ _tag: "message.info", body: "between chunks", timestamp });
      yield* sink.value.emit({ _tag: "stdout", kind: "bytes", chunk: "suffix\n" });
      return {};
    }),
    { ...options, io },
  );
  // Then
  const frames = decodeFrames(io.stdout());
  expect(frames.filter((frame) => frame._tag === "event")).toMatchObject([
    { _tag: "event", event: "message.info", payload: { body: "between chunks" } },
  ]);
  expect(frames.filter((frame) => frame._tag !== "event")).toMatchObject([
    { _tag: "stdout", chunk: "prefixsuffix\n" },
    { _tag: "result", envelope: { ok: true } },
  ]);
  expect(frames.at(-1)?._tag).toBe("result");
});
