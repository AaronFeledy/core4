import { describe, expect, test } from "bun:test";
import { StreamFrameSink } from "@lando/engine/operations/stream-frame-sink";
import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import { REDACTED } from "@lando/sdk/secrets";
import { Effect, Layer } from "effect";
import { createBufferedRendererIO } from "../src/io.ts";
import { layerStreamFrameSink } from "../src/output.ts";
import { layerPlainService } from "../src/runtime.ts";

const drive = async (format: "text" | "json", chunks: readonly (string | Uint8Array)[]) => {
  const io = createBufferedRendererIO();
  const service = makeRedactionService();
  Effect.runSync(service.registerValues(["known-secret"]));
  const layer = layerStreamFrameSink(format).pipe(
    Layer.provide(Layer.merge(layerPlainService(io), Layer.succeed(RedactionService, service))),
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      const sink = yield* StreamFrameSink;
      for (const chunk of chunks) yield* sink.emit({ _tag: "stdout", chunk, raw: true });
      if (sink.flush !== undefined) yield* sink.flush();
    }).pipe(Effect.provide(layer)),
  );
  return io;
};

describe("payload frames", () => {
  test("keeps a final incomplete UTF-8 sequence in its partial-line frame", async () => {
    // Given
    const bytes = new Uint8Array([97, 98, 99, 226, 130]);
    // When
    const io = await drive("json", [bytes]);
    // Then
    expect(io.stdoutLines().map((line) => JSON.parse(line))).toEqual([{ _tag: "stdout", chunk: "abc�" }]);
  });
  test.each(["text", "json"] as const)("masks split stderr values in %s", async (format) => {
    // Given
    const io = createBufferedRendererIO();
    const service = makeRedactionService();
    Effect.runSync(service.registerValues(["known-secret"]));
    const layer = layerStreamFrameSink(format).pipe(
      Layer.provide(Layer.merge(layerPlainService(io), Layer.succeed(RedactionService, service))),
    );
    // When
    await Effect.runPromise(
      Effect.gen(function* () {
        const sink = yield* StreamFrameSink;
        yield* sink.emit({ _tag: "stderr", chunk: "known-", raw: true });
        yield* sink.emit({ _tag: "stderr", chunk: "secret", raw: true });
        if (sink.flush !== undefined) yield* sink.flush();
      }).pipe(Effect.provide(layer)),
    );
    // Then
    if (format === "text") expect(io.stderr()).toBe(REDACTED);
    else
      expect(
        io
          .stdoutLines()
          .map((line) => JSON.parse(line).chunk)
          .join(""),
      ).toBe(REDACTED);
  });

  test("masks known values without decoding adjacent binary bytes", async () => {
    // Given
    const input = new Uint8Array([255, ...new TextEncoder().encode("known-secret"), 0, 128]);
    // When
    const io = await drive("text", [input]);
    // Then
    expect(io.stdoutBytes()).toEqual(new Uint8Array([255, ...new TextEncoder().encode(REDACTED), 0, 128]));
  });
  test("redacts split values and full-line patterns in JSON", async () => {
    // Given
    const chunks = ["known-", "secret\nPASSWORD=", "unregistered\nlast"];
    // When
    const io = await drive("json", chunks);
    // Then
    const frames = io.stdoutLines().map((line) => JSON.parse(line));
    expect(frames.map((frame) => frame.chunk).join("")).toBe(`${REDACTED}\nPASSWORD=${REDACTED}\nlast`);
    expect(frames).toHaveLength(3);
  });

  test("bounds newline-free JSON frames and replaces invalid UTF-8", async () => {
    // Given
    const bytes = new Uint8Array(131073).fill(120);
    bytes[131072] = 255;
    // When
    const io = await drive("json", [bytes]);
    // Then
    const frames = io.stdoutLines().map((line) => JSON.parse(line));
    expect(frames.map((frame) => frame.chunk.length)).toEqual([65536, 65536, 1]);
    expect(frames.at(-1)?.chunk).toBe("�");
  });

  test("sees process registrations after the sink is acquired", async () => {
    // Given
    const io = createBufferedRendererIO();
    const service = makeRedactionService();
    const layer = layerStreamFrameSink("text").pipe(
      Layer.provide(Layer.merge(layerPlainService(io), Layer.succeed(RedactionService, service))),
    );
    // When
    await Effect.runPromise(
      Effect.gen(function* () {
        const sink = yield* StreamFrameSink;
        yield* service.registerValues(["late-registration"]);
        yield* sink.emit({ _tag: "stdout", chunk: "late-reg", raw: true });
        yield* sink.emit({ _tag: "stdout", chunk: "istration!", raw: true });
        if (sink.flush !== undefined) yield* sink.flush();
      }).pipe(Effect.provide(layer)),
    );
    // Then
    expect(io.stdout()).toBe(`${REDACTED}!`);
  });
});
