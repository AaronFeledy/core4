import { describe, expect, test } from "bun:test";
import { Effect, Option, Stream } from "effect";

import { collectExecStream } from "../../src/operations/exec-stream.ts";
import { StreamFrameSink, type StreamFrameSinkFrame } from "../../src/operations/stream-frame-sink.ts";

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
});
