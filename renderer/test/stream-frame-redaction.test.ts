import { describe, expect, test } from "bun:test";
import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import { createBufferedRendererIO } from "@lando/renderer/io";
import * as RendererOutput from "@lando/renderer/output";
import * as RendererRuntime from "@lando/renderer/runtime";
import { REDACTED } from "@lando/sdk/secrets";
import { StreamFrameSink } from "@lando/sdk/services";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";

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

describe("time-bounded followed-log holds", () => {
  const serviceLayer = (values: readonly string[]) =>
    Layer.effect(
      RedactionService,
      Effect.gen(function* () {
        const service = makeRedactionService();
        if (values.length > 0) yield* service.registerValues([...values]);
        return service;
      }),
    );

  const runTimed = <A, E>(
    format: "text" | "json",
    io: ReturnType<typeof createBufferedRendererIO>,
    values: readonly string[],
    effect: Effect.Effect<A, E, StreamFrameSink>,
  ) =>
    Effect.runPromise(
      Effect.scoped(effect).pipe(
        Effect.provide(
          RendererOutput.layerStreamFrameSink(format).pipe(
            Layer.provide(
              Layer.merge(
                format === "json"
                  ? RendererRuntime.layerJsonService(io)
                  : RendererRuntime.layerPlainService(io),
                serviceLayer(values),
              ),
            ),
          ),
        ),
        Effect.provide(TestClock.layer()),
      ),
    );

  test("holds a split quoted text record until the deadline and emits one masked line", async () => {
    // Given
    const io = createBufferedRendererIO();
    // When
    await runTimed(
      "text",
      io,
      [],
      Effect.gen(function* () {
        const sink = yield* StreamFrameSink;
        yield* sink.emit({
          kind: "record",
          _tag: "stderr",
          chunk: 'password="first',
          service: "app",
          source: "logs",
        });
        yield* TestClock.adjust(499);
        expect(io.stderr()).toBe("");
        yield* TestClock.adjust(1);
        expect(io.stderr()).toBe("app stderr [logs]: password=[redacted]\n");
        yield* TestClock.adjust(5_000);
      }),
    );
    // Then no later clock advance changes the line.
    expect(io.stderr()).toBe("app stderr [logs]: password=[redacted]\n");
  });

  test("holds a split quoted JSON record until the deadline and emits one masked frame", async () => {
    // Given
    const io = createBufferedRendererIO();
    // When
    await runTimed(
      "json",
      io,
      [],
      Effect.gen(function* () {
        const sink = yield* StreamFrameSink;
        yield* sink.emit({
          kind: "record",
          _tag: "stderr",
          chunk: 'password="first',
          service: "app",
          source: "logs",
        });
        yield* TestClock.adjust(499);
        expect(io.stdout()).toBe("");
        yield* TestClock.adjust(1);
        expect(io.stdoutLines().map((line) => JSON.parse(line))).toEqual([
          { _tag: "stderr", chunk: "password=[redacted]\n", service: "app", source: "logs" },
        ]);
        yield* TestClock.adjust(5_000);
      }),
    );
    // Then later clock advances add nothing.
    expect(io.stdoutLines()).toHaveLength(1);
  });

  test("completes two JSON records inside the window as one masked frame", async () => {
    // Given
    const io = createBufferedRendererIO();
    // When
    await runTimed(
      "json",
      io,
      [],
      Effect.gen(function* () {
        const sink = yield* StreamFrameSink;
        yield* sink.emit({ kind: "record", _tag: "stdout", chunk: 'password="a', service: "app" });
        yield* TestClock.adjust(499);
        yield* sink.emit({ kind: "record", _tag: "stdout", chunk: 'b"', service: "app" });
        expect(io.stdoutLines().map((line) => JSON.parse(line))).toEqual([
          { _tag: "stdout", chunk: "password=[redacted]\n", service: "app" },
        ]);
      }),
    );
    // Then the completed value is one frame, not a per-record split.
    expect(io.stdoutLines().map((line) => JSON.parse(line))).toEqual([
      { _tag: "stdout", chunk: "password=[redacted]\n", service: "app" },
    ]);
  });

  test("masks a registered multi-line value across records", async () => {
    // Given
    const io = createBufferedRendererIO();
    // When
    await runTimed(
      "text",
      io,
      ["left\nright"],
      Effect.gen(function* () {
        const sink = yield* StreamFrameSink;
        yield* sink.emit({
          kind: "record",
          _tag: "stderr",
          chunk: "before left",
          service: "app",
          source: "logs",
        });
        yield* sink.emit({
          kind: "record",
          _tag: "stderr",
          chunk: "right after",
          service: "app",
          source: "logs",
        });
      }),
    );
    // Then the value is one masked line, never split across records.
    expect(io.stderr()).toBe("app stderr [logs]: before [redacted] after\n");
  });

  test("expires a withheld registered-value prefix and releases its line once", async () => {
    // Given
    const io = createBufferedRendererIO();
    // When a registered value's prefix is withheld by the value layer.
    await runTimed(
      "text",
      io,
      ["left\nright"],
      Effect.gen(function* () {
        const sink = yield* StreamFrameSink;
        yield* sink.emit({
          kind: "record",
          _tag: "stderr",
          chunk: "before left",
          service: "app",
          source: "logs",
        });
        yield* TestClock.adjust(499);
        expect(io.stderr()).toBe("");
        yield* TestClock.adjust(1);
        expect(io.stderr()).toBe("app stderr [logs]: before [redacted]\n");
      }),
    );
    // Then the expired prefix is committed masked as one line.
    expect(io.stderr()).toBe("app stderr [logs]: before [redacted]\n");
  });

  test("finish flushes a held record and later clock advances write nothing", async () => {
    // Given
    const io = createBufferedRendererIO();
    // When
    await Effect.runPromise(
      Effect.gen(function* () {
        const owner = yield* RendererOutput.makeStreamFrameSink("json");
        yield* owner.sink.emit({ kind: "record", _tag: "stdout", chunk: 'password="first' });
        yield* owner.finish();
        expect(io.stdoutLines().map((line) => JSON.parse(line))).toEqual([
          { _tag: "stdout", chunk: "password=[redacted]\n" },
        ]);
        yield* TestClock.adjust(5_000);
        yield* owner.finish();
      }).pipe(
        Effect.provide(Layer.merge(RendererRuntime.layerJsonService(io), redaction)),
        Effect.provide(TestClock.layer()),
      ),
    );
    // Then the one held frame was flushed before the later advances.
    expect(io.stdoutLines().map((line) => JSON.parse(line))).toEqual([
      { _tag: "stdout", chunk: "password=[redacted]\n" },
    ]);
  });
});
