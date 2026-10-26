import { describe, expect, test } from "bun:test";
import { StreamFrameSink } from "@lando/engine/operations/stream-frame-sink";
import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import { createBufferedRendererIO } from "@lando/renderer/io";
import * as RendererOutput from "@lando/renderer/output";
import * as RendererRuntime from "@lando/renderer/runtime";
import { REDACTED } from "@lando/sdk/secrets";
import { Effect, Layer } from "effect";

const secret = "s3cret-exec-pipe-value";
const payload = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0xff, 0x00, 0x80, 0xfe, 0x7f, 0x00]);

const redaction = Layer.effect(
  RedactionService,
  Effect.gen(function* () {
    const service = makeRedactionService();
    yield* service.registerValues([secret]);
    return service;
  }),
);

const emitRaw = async (
  io: ReturnType<typeof createBufferedRendererIO>,
  chunk: string | Uint8Array,
  tag: "stdout" | "stderr" = "stdout",
) => {
  const layer = RendererOutput.layerStreamFrameSink("text").pipe(
    Layer.provide(Layer.merge(RendererRuntime.layerPlainService(io), redaction)),
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      const sink = yield* StreamFrameSink;
      yield* sink.emit({ _tag: tag, chunk, kind: "bytes" });
    }).pipe(Effect.provide(layer)),
  );
};

describe("stream frame redaction", () => {
  test("masks a registered value split across chunks", async () => {
    // Given
    const io = createBufferedRendererIO();
    const layer = RendererOutput.layerStreamFrameSink("text").pipe(
      Layer.provide(Layer.merge(RendererRuntime.layerPlainService(io), redaction)),
    );
    // When
    await Effect.runPromise(
      Effect.gen(function* () {
        const sink = yield* StreamFrameSink;
        yield* sink.emit({ _tag: "stdout", chunk: secret.slice(0, 7), kind: "bytes" });
        yield* sink.emit({ _tag: "stdout", chunk: secret.slice(7), kind: "bytes" });
      }).pipe(Effect.provide(layer)),
    );
    // Then
    expect(io.stdout()).toBe(REDACTED);
  });

  test("preserves unregistered assignment payload", async () => {
    // Given
    const io = createBufferedRendererIO();
    const text =
      "PASSWORD=hunter2-not-registered\nhttps://public:pass@example.test/?token=public\nBearer public-token\n";
    // When
    await emitRaw(io, text);
    // Then
    expect(io.stdout()).toBe(text);
  });

  test("preserves identical binary bytes on terminal and file sinks", async () => {
    // Given
    const terminal = createBufferedRendererIO({ isTTY: true, stdoutIsTTY: true });
    const file = createBufferedRendererIO();
    // When
    await emitRaw(terminal, payload);
    await emitRaw(file, payload);
    // Then
    expect(terminal.stdoutBytes()).toEqual(file.stdoutBytes());
  });
  test("redacts a secret in redirected UTF-8 exec output", async () => {
    // Given: a real secrets redactor, a password in the env, and a redirected sink.
    const io = createBufferedRendererIO();

    // When
    await emitRaw(io, new TextEncoder().encode(`password=${secret}\n`));

    // Then
    expect(io.stdout()).toContain(REDACTED);
    expect(io.stdout()).not.toContain(secret);
  });

  test("redacts a secret on a TTY even when byte writers exist", async () => {
    // Given
    const io = createBufferedRendererIO({ isTTY: true, stdoutIsTTY: true });

    // When
    await emitRaw(io, new TextEncoder().encode(`token=${secret}`));

    // Then
    expect(io.stdout()).toContain(REDACTED);
    expect(io.stdout()).not.toContain(secret);
  });

  test("passes raw bytes when redirected stdout is not valid UTF-8", async () => {
    // Given
    const io = createBufferedRendererIO();

    // When
    await emitRaw(io, payload);

    // Then
    expect(io.stdoutBytes()).toEqual(payload);
  });

  test("keeps a multibyte character that splits across redirected chunks", async () => {
    // Given
    const io = createBufferedRendererIO();
    const euro = new TextEncoder().encode("pay-€-now");
    const layer = RendererOutput.layerStreamFrameSink("text").pipe(
      Layer.provide(Layer.merge(RendererRuntime.layerPlainService(io), redaction)),
    );

    // When: the euro sign is 0xe2 0x82 0xac and lands on a chunk boundary.
    await Effect.runPromise(
      Effect.gen(function* () {
        const sink = yield* StreamFrameSink;
        yield* sink.emit({ _tag: "stdout", chunk: euro.subarray(0, 5), kind: "bytes" });
        yield* sink.emit({ _tag: "stdout", chunk: euro.subarray(5), kind: "bytes" });
      }).pipe(Effect.provide(layer)),
    );

    // Then
    expect(io.stdoutBytes()).toEqual(euro);
  });

  test("writes held UTF-8 bytes when a redirected stream turns binary", async () => {
    // Given: abc plus a held 0xe2, then invalid bytes.
    const io = createBufferedRendererIO();
    const input = new Uint8Array([0x61, 0x62, 0x63, 0xe2, 0xff, 0x00, 0x01]);
    const layer = RendererOutput.layerStreamFrameSink("text").pipe(
      Layer.provide(Layer.merge(RendererRuntime.layerPlainService(io), redaction)),
    );

    // When
    await Effect.runPromise(
      Effect.gen(function* () {
        const sink = yield* StreamFrameSink;
        yield* sink.emit({ _tag: "stdout", chunk: input.subarray(0, 4), kind: "bytes" });
        yield* sink.emit({ _tag: "stdout", chunk: input.subarray(4), kind: "bytes" });
      }).pipe(Effect.provide(layer)),
    );

    // Then
    expect(io.stdoutBytes()).toEqual(input);
  });

  test("flushes a trailing incomplete UTF-8 sequence as raw bytes", async () => {
    // Given: abc plus an unfinished 3-byte sequence at end of stream.
    const io = createBufferedRendererIO();
    const input = new Uint8Array([0x61, 0x62, 0x63, 0xe2, 0x82]);
    const layer = RendererOutput.layerStreamFrameSink("text").pipe(
      Layer.provide(Layer.merge(RendererRuntime.layerPlainService(io), redaction)),
    );

    // When
    await Effect.runPromise(
      Effect.gen(function* () {
        const sink = yield* StreamFrameSink;
        yield* sink.emit({ _tag: "stdout", chunk: input, kind: "bytes" });
      }).pipe(Effect.provide(layer)),
    );

    // Then
    expect(io.stdoutBytes()).toEqual(input);
  });

  test("preserves a leading UTF-8 BOM through redirected exec output", async () => {
    // Given: a redirected sink and EF BB BF hello, which used to become hellollo.
    const io = createBufferedRendererIO();
    const input = new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x65, 0x6c, 0x6c, 0x6f]);
    const layer = RendererOutput.layerStreamFrameSink("text").pipe(
      Layer.provide(Layer.merge(RendererRuntime.layerPlainService(io), redaction)),
    );

    // When
    await Effect.runPromise(
      Effect.gen(function* () {
        const sink = yield* StreamFrameSink;
        yield* sink.emit({ _tag: "stdout", chunk: input, kind: "bytes" });
      }).pipe(Effect.provide(layer)),
    );

    // Then
    expect(io.stdoutBytes()).toEqual(input);
    expect(io.stdoutBytes()).not.toEqual(new TextEncoder().encode("hellollo"));
  });

  test("preserves trailing invalid UTF-8 bytes on a TTY sink", async () => {
    // Given: a TTY sink and an unfinished sequence.
    const io = createBufferedRendererIO({ isTTY: true, stdoutIsTTY: true });
    const input = new Uint8Array([0x61, 0x62, 0x63, 0xe2, 0x82]);
    const layer = RendererOutput.layerStreamFrameSink("text").pipe(
      Layer.provide(Layer.merge(RendererRuntime.layerPlainService(io), redaction)),
    );

    // When
    await Effect.runPromise(
      Effect.gen(function* () {
        const sink = yield* StreamFrameSink;
        yield* sink.emit({ _tag: "stdout", chunk: input, kind: "bytes" });
      }).pipe(Effect.provide(layer)),
    );

    // Then
    expect(io.stdoutBytes()).toEqual(input);
  });
});
