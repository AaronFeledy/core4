import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect, Layer, Schema } from "effect";

import { CommandResultEnvelope, StreamFrame } from "@lando/sdk/schema";

import { createBufferedRendererIO } from "@lando/renderer/io";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary.ts";

const TinyResultSchema = Schema.Struct({ name: Schema.String });

const decodeFrame = (line: string) => Schema.decodeUnknownSync(StreamFrame)(JSON.parse(line));

const decodeEnvelope = (line: string) => Schema.decodeUnknownSync(CommandResultEnvelope)(JSON.parse(line));

beforeEach(() => {
  process.exitCode = undefined;
});

afterEach(() => {
  process.exitCode = undefined;
});

describe("runWithRendererHandling streaming jqExpression", () => {
  test("emits chunk frames then a non-envelope last line", async () => {
    // Given a streaming success plus --jq .result.name.
    const io = createBufferedRendererIO();
    let exitCode: number | undefined;

    // When the command emits stdout/stderr frames and a tiny result.
    await runWithRendererHandling(Effect.succeed({ name: "demo" }), {
      runtime: Layer.empty,
      rendererMode: "json",
      resultFormat: "json",
      command: "app:logs",
      resultSchema: TinyResultSchema,
      streaming: StreamFrame,
      streamFrames: () => [
        { _tag: "stdout", service: "web", chunk: "stdout chunk\n" },
        { _tag: "stderr", service: "web", chunk: "stderr chunk\n" },
      ],
      jqExpression: ".result.name",
      io,
      render: () => "should not render",
      formatError: () => "unexpected",
      setExitCode: (code) => {
        exitCode = code;
      },
    });

    // Then intermediate frames stay stream frames and the last line is raw jq output.
    const lines = io.stdoutLines();
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(decodeFrame(lines[0] ?? "{}")).toMatchObject({
      _tag: "stdout",
      service: "web",
      chunk: "stdout chunk\n",
    });
    expect(decodeFrame(lines[1] ?? "{}")).toMatchObject({
      _tag: "stderr",
      service: "web",
      chunk: "stderr chunk\n",
    });
    const last = lines[lines.length - 1];
    expect(last).toBe("demo");
    expect(() => decodeFrame(last ?? "{}")).toThrow();
    expect(io.stderr()).toBe("");
    expect(exitCode).toBeUndefined();
  });

  test("does not jq intermediate stream chunks", async () => {
    // Given streaming frames whose chunk text would change if jq ran on them.
    const io = createBufferedRendererIO();

    // When jq selects a scalar from the terminal envelope only.
    await runWithRendererHandling(Effect.succeed({ name: "demo" }), {
      runtime: Layer.empty,
      rendererMode: "json",
      resultFormat: "json",
      command: "app:logs",
      resultSchema: TinyResultSchema,
      streaming: StreamFrame,
      streamFrames: () => [{ _tag: "stdout", chunk: '{"keep":true}\n' }],
      jqExpression: ".result.name",
      io,
      render: () => "should not render",
      formatError: () => "unexpected",
    });

    // Then the stdout frame chunk is unchanged.
    const lines = io.stdoutLines();
    expect(decodeFrame(lines[0] ?? "{}")).toMatchObject({
      _tag: "stdout",
      chunk: '{"keep":true}\n',
    });
    expect(lines[lines.length - 1]).toBe("demo");
  });

  test("exits 2 on jq eval failure after writing stream chunks only", async () => {
    // Given streaming success and an invalid jq expression.
    const io = createBufferedRendererIO();
    let exitCode: number | undefined;

    // When the terminal result line fails to evaluate.
    await runWithRendererHandling(Effect.succeed({ name: "demo" }), {
      runtime: Layer.empty,
      rendererMode: "json",
      resultFormat: "json",
      command: "app:logs",
      resultSchema: TinyResultSchema,
      streaming: StreamFrame,
      streamFrames: () => [{ _tag: "stdout", chunk: "chunk\n" }],
      jqExpression: "oops(",
      io,
      render: () => "should not render",
      formatError: () => "unexpected",
      setExitCode: (code) => {
        exitCode = code;
      },
    });

    // Then chunks remain, exit is 2, and stdout is not an envelope+jq mix.
    expect(exitCode).toBe(2);
    const lines = io.stdoutLines();
    expect(decodeFrame(lines[0] ?? "{}")).toMatchObject({ _tag: "stdout", chunk: "chunk\n" });
    const last = lines[lines.length - 1] ?? "";
    expect(last.includes("demo") && last.includes("oops(")).toBe(false);
    if (last.startsWith("{")) {
      try {
        const frame = decodeFrame(last);
        if (frame._tag === "result") {
          expect(frame.envelope.error).toMatchObject({ _tag: "JqExpressionError" });
        }
      } catch {
        const envelope = decodeEnvelope(last);
        expect(envelope.ok).toBe(false);
        expect(envelope.error).toMatchObject({ _tag: "JqExpressionError" });
      }
    }
  });
});
