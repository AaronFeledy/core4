import { expect, test } from "bun:test";
import { createBufferedRendererIO } from "@lando/renderer/io";
import { CommandResultEnvelope, StreamFrame } from "@lando/sdk/schema";
import { EventService } from "@lando/sdk/services";
import { Effect, Layer, Schema } from "effect";
import { CommandPayloadStdout } from "../../src/cli/command-payload-stdout";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary";

const options = {
  runtime: Layer.empty,
  rendererMode: "json",
  resultFormat: "json",
  command: "fixture:dump",
  resultSchema: Schema.Struct({ name: Schema.String, status: Schema.String }),
  streaming: StreamFrame,
  streamFrames: () =>
    [
      { _tag: "stdout", service: "web", chunk: "stdout chunk\n" },
      { _tag: "stderr", service: "web", chunk: "stderr chunk\n" },
    ] as const,
  formatError: () => "unexpected failure",
} as const;

const result = { name: "demo", status: "started" };
const publishProgress = Effect.gen(function* () {
  const events = yield* EventService;
  const timestamp = "2026-10-30T00:00:00.000Z";
  yield* events.publish({ _tag: "message.info", body: "starting", timestamp });
  yield* events.publish({ _tag: "message.info", body: "started", timestamp });
});
const streamingSuccess = Effect.andThen(publishProgress, Effect.succeed(result));

test("streaming key projection writes only the projected result envelope", async () => {
  const io = createBufferedRendererIO();
  const codes: number[] = [];
  await runWithRendererHandling(streamingSuccess, {
    ...options,
    io,
    projectResultKeys: ["name"],
    setExitCode: (code) => codes.push(code),
  });

  const envelope = Schema.decodeUnknownSync(CommandResultEnvelope)(JSON.parse(io.stdout()));
  expect(envelope.ok).toBe(true);
  expect(envelope.result).toEqual({ name: "demo" });
  expect(io.stderr()).toBe("");
  expect(codes).toEqual([0]);
});

test("streaming jq selects from the failure envelope and preserves exit 1", async () => {
  const io = createBufferedRendererIO();
  const codes: number[] = [];
  await runWithRendererHandling(Effect.andThen(publishProgress, Effect.fail("command failed")), {
    ...options,
    io,
    jqExpression: ".ok",
    setExitCode: (code) => codes.push(code),
  });

  expect(io.stdout()).toBe("false\n");
  expect(io.stderr()).toBe("");
  expect(codes).toEqual([1]);
});

test("unselected buffered JSON writes ordered events and data before its only result frame", async () => {
  const io = createBufferedRendererIO();
  await runWithRendererHandling(streamingSuccess, { ...options, io, setExitCode: () => undefined });

  const frames = io.stdoutLines().map((line) => Schema.decodeUnknownSync(StreamFrame)(JSON.parse(line)));
  expect(frames).toMatchObject([
    { _tag: "event", event: "message.info", payload: { body: "starting" } },
    { _tag: "event", event: "message.info", payload: { body: "started" } },
    { _tag: "stdout", service: "web", chunk: "stdout chunk\n" },
    { _tag: "stderr", service: "web", chunk: "stderr chunk\n" },
    { _tag: "result", envelope: { ok: true, result: { name: "demo", status: "started" } } },
  ]);
  expect(io.stderr()).toBe("");
});

test("jq writes no buffered data frames beside a granted stdout payload", async () => {
  const io = createBufferedRendererIO();
  const payload = new Uint8Array([0, 255, 10, 13, 65]);
  const codes: number[] = [];

  await runWithRendererHandling(
    Effect.gen(function* () {
      const write = yield* Effect.serviceOption(CommandPayloadStdout);
      if (write._tag === "None") throw new Error("expected stdout grant");
      yield* write.value(payload);
      return result;
    }),
    {
      ...options,
      io,
      payloadStdout: true,
      jqExpression: ".result.name",
      setExitCode: (code) => codes.push(code),
    },
  );

  expect(io.stdoutBytes()).toEqual(payload);
  expect(io.stderr()).toBe("demo\n");
  expect(codes).toEqual([0]);
});

test("a jq evaluation failure writes one failure envelope and no buffered data frames", async () => {
  const io = createBufferedRendererIO();
  const codes: number[] = [];

  await runWithRendererHandling(Effect.succeed(result), {
    ...options,
    io,
    jqExpression: '1, error("failed selection")',
    setExitCode: (code) => codes.push(code),
  });

  expect(Schema.decodeUnknownSync(CommandResultEnvelope)(JSON.parse(io.stdout()))).toMatchObject({
    ok: false,
    error: { _tag: "JqExpressionError" },
  });
  expect(io.stderr()).toBe("");
  expect(codes).toEqual([2]);
});
