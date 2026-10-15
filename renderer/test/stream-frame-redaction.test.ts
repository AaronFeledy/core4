import { describe, expect, test } from "bun:test";
import { StreamFrameSink } from "@lando/engine/operations/stream-frame-sink";
import {
  RedactionService,
  createStandaloneRedactor,
  registerRedactionValues,
} from "@lando/redaction/service";
import { createBufferedRendererIO } from "@lando/renderer/io";
import * as RendererOutput from "@lando/renderer/output";
import * as RendererRuntime from "@lando/renderer/runtime";
import { REDACTED } from "@lando/sdk/secrets";
import { Effect, Layer } from "effect";

const secret = "s3cret-exec-pipe-value";
const payload = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0xff, 0x00, 0x80, 0xfe, 0x7f, 0x00]);

const redaction = Layer.succeed(
  RedactionService,
  RedactionService.of({
    registerValues: registerRedactionValues,
    forProfile: () =>
      Effect.succeed(createStandaloneRedactor("secrets", { sourceEnv: { DB_PASSWORD: secret } })),
  }),
);

const emitRaw = async (
  io: ReturnType<typeof createBufferedRendererIO>,
  chunk: string | Uint8Array,
  tag: "stdout" | "stderr" = "stdout",
) => {
  const layer = RendererOutput.layerStreamFrameSink("text", io).pipe(
    Layer.provide(Layer.merge(RendererRuntime.layerPlainService(io), redaction)),
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      const sink = yield* StreamFrameSink;
      yield* sink.emit({ _tag: tag, chunk, raw: true });
    }).pipe(Effect.provide(layer)),
  );
};

describe("stream frame redaction", () => {
  test("redacts a secret in redirected UTF-8 exec output", async () => {
    // Given: a real secrets redactor, a password in the env, and a redirected sink.
    const io = createBufferedRendererIO();

    // When
    await emitRaw(io, new TextEncoder().encode(`password=${secret}\n`));

    // Then: ordinary lando exec text still goes through redactString.
    expect(io.stdout()).toContain(REDACTED);
    expect(io.stdout()).not.toContain(secret);
  });

  test("redacts a secret on a TTY even when byte writers exist", async () => {
    // Given
    const io = createBufferedRendererIO({ isTTY: true });

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
    const layer = RendererOutput.layerStreamFrameSink("text", io).pipe(
      Layer.provide(Layer.merge(RendererRuntime.layerPlainService(io), redaction)),
    );

    // When: the euro sign is 0xe2 0x82 0xac and lands on a chunk boundary.
    await Effect.runPromise(
      Effect.gen(function* () {
        const sink = yield* StreamFrameSink;
        yield* sink.emit({ _tag: "stdout", chunk: euro.subarray(0, 5), raw: true });
        yield* sink.emit({ _tag: "stdout", chunk: euro.subarray(5), raw: true });
      }).pipe(Effect.provide(layer)),
    );

    // Then
    expect(io.stdout()).toBe("pay-€-now");
  });

  test("writes held UTF-8 bytes when a redirected stream turns binary", async () => {
    // Given: abc plus a held 0xe2, then invalid bytes.
    const io = createBufferedRendererIO();
    const input = new Uint8Array([0x61, 0x62, 0x63, 0xe2, 0xff, 0x00, 0x01]);
    const layer = RendererOutput.layerStreamFrameSink("text", io).pipe(
      Layer.provide(Layer.merge(RendererRuntime.layerPlainService(io), redaction)),
    );

    // When
    await Effect.runPromise(
      Effect.gen(function* () {
        const sink = yield* StreamFrameSink;
        yield* sink.emit({ _tag: "stdout", chunk: input.subarray(0, 4), raw: true });
        yield* sink.emit({ _tag: "stdout", chunk: input.subarray(4), raw: true });
      }).pipe(Effect.provide(layer)),
    );

    // Then
    expect(io.stdoutBytes()).toEqual(input);
  });

  test("flushes a trailing incomplete UTF-8 sequence as raw bytes", async () => {
    // Given: abc plus an unfinished 3-byte sequence at end of stream.
    const io = createBufferedRendererIO();
    const input = new Uint8Array([0x61, 0x62, 0x63, 0xe2, 0x82]);
    const layer = RendererOutput.layerStreamFrameSink("text", io).pipe(
      Layer.provide(Layer.merge(RendererRuntime.layerPlainService(io), redaction)),
    );

    // When
    await Effect.runPromise(
      Effect.gen(function* () {
        const sink = yield* StreamFrameSink;
        yield* sink.emit({ _tag: "stdout", chunk: input, raw: true });
        if (sink.flush !== undefined) yield* sink.flush();
      }).pipe(Effect.provide(layer)),
    );

    // Then
    expect(io.stdoutBytes()).toEqual(input);
  });

  test("preserves a leading UTF-8 BOM through redirected exec output", async () => {
    // Given: a redirected sink and EF BB BF hello, which used to become hellollo.
    const io = createBufferedRendererIO();
    const input = new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x65, 0x6c, 0x6c, 0x6f]);
    const layer = RendererOutput.layerStreamFrameSink("text", io).pipe(
      Layer.provide(Layer.merge(RendererRuntime.layerPlainService(io), redaction)),
    );

    // When
    await Effect.runPromise(
      Effect.gen(function* () {
        const sink = yield* StreamFrameSink;
        yield* sink.emit({ _tag: "stdout", chunk: input, raw: true });
        if (sink.flush !== undefined) yield* sink.flush();
      }).pipe(Effect.provide(layer)),
    );

    // Then
    expect(io.stdoutBytes()).toEqual(input);
    expect(io.stdoutBytes()).not.toEqual(new TextEncoder().encode("hellollo"));
  });

  test("does not write raw leftover bytes when flushing a TTY sink", async () => {
    // Given: a TTY sink whose decoder is non-fatal, plus an unfinished sequence.
    const io = createBufferedRendererIO({ isTTY: true });
    const input = new Uint8Array([0x61, 0x62, 0x63, 0xe2, 0x82]);
    const layer = RendererOutput.layerStreamFrameSink("text", io).pipe(
      Layer.provide(Layer.merge(RendererRuntime.layerPlainService(io), redaction)),
    );

    // When
    await Effect.runPromise(
      Effect.gen(function* () {
        const sink = yield* StreamFrameSink;
        yield* sink.emit({ _tag: "stdout", chunk: input, raw: true });
        if (sink.flush !== undefined) yield* sink.flush();
      }).pipe(Effect.provide(layer)),
    );

    // Then: leftover stays off the raw path. Flush must not call writeRaw on a TTY.
    expect(io.stdout()).toBe("abc");
    expect(io.stdoutBytes()).toEqual(new TextEncoder().encode("abc"));
  });
});
