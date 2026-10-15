import { describe, expect, test } from "bun:test";
import { Effect, Exit, Layer, Option, Stream } from "effect";

import {
  RedactionService,
  createStandaloneRedactor,
  registerRedactionValues,
} from "@lando/redaction/service";
import { createBufferedRendererIO } from "@lando/renderer/io";
import * as RendererOutput from "@lando/renderer/output";
import * as RendererRuntime from "@lando/renderer/runtime";

import { collectExecStream } from "../../src/operations/exec-stream.ts";
import { StreamFrameSink, type StreamFrameSinkFrame } from "../../src/operations/stream-frame-sink.ts";

const identityRedaction = Layer.succeed(
  RedactionService,
  RedactionService.of({
    registerValues: registerRedactionValues,
    forProfile: () => Effect.succeed(createStandaloneRedactor("secrets", { sourceEnv: {} })),
  }),
);

const concat = (chunks: ReadonlyArray<string | Uint8Array>): Uint8Array => {
  const encoded = chunks.map((chunk) =>
    typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk,
  );
  const bytes = new Uint8Array(encoded.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of encoded) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

describe("collectExecStream binary frames", () => {
  test("emits provider stdout and stderr bytes without UTF-8 replacement", async () => {
    // Given: gzip magic plus invalid UTF-8, split across two frames.
    const payload = new Uint8Array([0x1f, 0x8b, 0x00, 0xff, 0x80, 0xfe]);
    const frames: StreamFrameSinkFrame[] = [];
    const sink = StreamFrameSink.of({
      emit: (frame) => Effect.sync(() => frames.push(frame)),
    });

    // When
    const result = await Effect.runPromise(
      collectExecStream(
        Stream.fromIterable([
          { kind: "stdout" as const, chunk: payload.slice(0, 3) },
          { kind: "stderr" as const, chunk: new Uint8Array([0x00, 0xff]) },
          { kind: "stdout" as const, chunk: payload.slice(3) },
          { exitCode: 0 },
        ]),
        Option.some(sink),
      ),
    );

    // Then
    expect(result.exitCode).toBe(0);
    expect(concat(frames.filter((frame) => frame._tag === "stdout").map((frame) => frame.chunk))).toEqual(
      payload,
    );
    expect(concat(frames.filter((frame) => frame._tag === "stderr").map((frame) => frame.chunk))).toEqual(
      new Uint8Array([0x00, 0xff]),
    );
    expect(frames.every((frame) => frame.raw === true)).toBe(true);
  });

  test("flushes the sink after the provider stream ends", async () => {
    // Given
    let flushed = 0;
    const sink = StreamFrameSink.of({
      emit: () => Effect.void,
      flush: () =>
        Effect.sync(() => {
          flushed += 1;
        }),
    });

    // When
    await Effect.runPromise(collectExecStream(Stream.fromIterable([{ exitCode: 0 }]), Option.some(sink)));

    // Then
    expect(flushed).toBe(1);
  });

  test("flushes the sink when the provider stream fails", async () => {
    // Given
    let flushed = 0;
    const sink = StreamFrameSink.of({
      emit: () => Effect.void,
      flush: () =>
        Effect.sync(() => {
          flushed += 1;
        }),
    });

    // When
    const exit = await Effect.runPromiseExit(
      collectExecStream(Stream.fail("injected-stream-failure"), Option.some(sink)),
    );

    // Then
    expect(Exit.isFailure(exit)).toBe(true);
    expect(flushed).toBe(1);
  });

  test("writes held UTF-8 bytes when the provider stream fails", async () => {
    // Given: abc plus an unfinished 3-byte sequence, then the stream fails.
    const io = createBufferedRendererIO();
    const input = new Uint8Array([0x61, 0x62, 0x63, 0xe2, 0x82]);
    const layer = RendererOutput.layerStreamFrameSink("text", io).pipe(
      Layer.provide(Layer.merge(RendererRuntime.layerPlainService(io), identityRedaction)),
    );

    // When
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const sink = yield* StreamFrameSink;
        return yield* collectExecStream(
          Stream.make({ kind: "stdout" as const, chunk: input }).pipe(
            Stream.concat(Stream.fail("injected-stream-failure")),
          ),
          Option.some(sink),
        );
      }).pipe(Effect.provide(layer)),
    );

    // Then: flush still writes the held tail so abc E2 82 is not truncated to abc.
    expect(Exit.isFailure(exit)).toBe(true);
    expect(io.stdoutBytes()).toEqual(input);
  });
});
