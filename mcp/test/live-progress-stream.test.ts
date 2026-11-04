import { describe, expect, test } from "bun:test";
import type { StreamFrameSinkFrame } from "@lando/engine/operations/stream-frame-sink";
import { McpTransportError } from "@lando/sdk/errors";
import { createRedactor } from "@lando/sdk/secrets";
import { Deferred, Effect, Exit, Fiber } from "effect";
import { makeStreamFrameSink } from "../src/progress";
import { flushProgress, progressFixture } from "./live-progress-fixture";

type Channel = Pick<StreamFrameSinkFrame, "_tag" | "service" | "source">;

describe("MCP live channel streams", () => {
  test("keeps service, source and stdout/stderr decoder and redaction tails isolated", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        // Given four independent channels and one live secret.
        const { sink, owner, service, frames } = yield* progressFixture();
        yield* service.registerValues(["private-value"]);
        const channels: readonly [Channel, Channel, Channel, Channel] = [
          { _tag: "stdout", service: "app", source: "one" },
          { _tag: "stderr", service: "app", source: "one" },
          { _tag: "stdout", service: "db", source: "one" },
          { _tag: "stdout", service: "app", source: "two" },
        ];
        // When interleaved tails would form a secret or a UTF-8 sequence if mixed.
        yield* sink.emit({ ...channels[0], chunk: "private-", kind: "bytes" });
        yield* sink.emit({ ...channels[1], chunk: "value\n", kind: "bytes" });
        yield* sink.emit({ ...channels[2], chunk: new Uint8Array([0xe2]), kind: "bytes" });
        yield* sink.emit({ ...channels[3], chunk: new Uint8Array([0x82, 0xac, 10]), kind: "bytes" });
        yield* sink.emit({ ...channels[0], chunk: "value\n", kind: "bytes" });
        yield* flushProgress(owner);
        // Then only the first channel forms a secret, and decoder tails do not mix.
        expect(frames).toEqual([
          { ...channels[1], chunk: "value\n" },
          { ...channels[3], chunk: "��\n" },
          { ...channels[0], chunk: "[redacted]\n" },
          { ...channels[2], chunk: "�" },
        ]);
      }),
    );
  });

  test("segments large byte input at 64 KiB and finalizes an empty decoder tail", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        // Given a multi-megabyte input with a code point crossing a segment boundary.
        const { sink, owner, frames, text } = yield* progressFixture();
        const input = `${"x".repeat(65_535)}😀${"y".repeat(2_000_000)}\n`;
        // When one large provider chunk and a decoder-only trailing prefix are emitted.
        yield* sink.emit({ _tag: "stdout", chunk: Buffer.from(input), kind: "bytes" });
        const edge = new Uint8Array(65_536).fill(120);
        edge[65_535] = 0xe2;
        yield* sink.emit({ _tag: "stdout", chunk: edge, kind: "bytes" });
        yield* flushProgress(owner);
        // Then bytes are decoded once and all notifications stay bounded.
        expect(text()).toBe(`${input}${"x".repeat(65_535)}�`);
        expect(frames.every((frame) => Buffer.byteLength(frame.chunk) <= 65_539)).toBe(true);
        expect(frames.length).toBeGreaterThan(30);
      }),
    );
  });

  test("awaits notifications and serializes concurrent emits and drains", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          // Given a notification held by downstream backpressure.
          const started = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const chunks: unknown[] = [];
          let writes = 0;
          const owner = makeStreamFrameSink(
            (frame) =>
              Effect.gen(function* () {
                writes++;
                yield* Deferred.succeed(started, undefined);
                yield* Deferred.await(release);
                chunks.push(frame);
              }),
            createRedactor("secrets", { values: [] }),
            () => [],
          );
          // When another emit and flush compete while the first notify is blocked.
          const first = yield* owner.sink
            .emit({ _tag: "stdout", chunk: "first\n", kind: "bytes" })
            .pipe(Effect.forkScoped);
          yield* Deferred.await(started);
          const second = yield* owner.sink
            .emit({ _tag: "stdout", chunk: "second\n", kind: "bytes" })
            .pipe(Effect.forkScoped);
          const drain = yield* flushProgress(owner).pipe(Effect.forkScoped);
          expect(writes).toBe(1);
          expect(chunks).toEqual([]);
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(first);
          yield* Fiber.join(second);
          yield* Fiber.join(drain);
          // Then each detached segment is delivered once in order.
          expect(chunks).toEqual([
            { _tag: "stdout", chunk: "first\n" },
            { _tag: "stdout", chunk: "second\n" },
          ]);
        }),
      ),
    );
  });

  test("redacts a secret split across bounded input pieces without profile leakage", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        // Given one large input whose secret crosses the 64 KiB processing boundary.
        const { sink, owner, service, frames, text } = yield* progressFixture();
        yield* service.registerValues(["private-value"]);
        const prefix = "x".repeat(65_532);
        // When bytes pass through payload redaction before segmentation and profile encoding.
        yield* sink.emit({
          _tag: "stdout",
          chunk: Buffer.from(`${prefix}private-value\npassword=visible\n`),
          kind: "bytes",
        });
        yield* flushProgress(owner);
        // Then neither exact-value bytes nor profile-pattern credentials escape.
        expect(text()).toBe(`${prefix}[redacted]\npassword=[redacted]\n`);
        expect(frames.every((frame) => !frame.chunk.includes("private-value"))).toBe(true);
      }),
    );
  });

  test("detaches draining data before a notification defect and accepts later emits", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        // Given a downstream that records a write but fails its first acknowledgement.
        const frames: unknown[] = [];
        const owner = makeStreamFrameSink(
          (frame) =>
            Effect.gen(function* () {
              frames.push(frame);
              if (frames.length === 1)
                return yield* Effect.fail(
                  new McpTransportError({ message: "write failed", remediation: "retry" }),
                );
            }),
          createRedactor("secrets", { values: [] }),
          () => [],
        );
        yield* owner.sink.emit({ _tag: "stdout", chunk: "held", kind: "bytes" });
        // When a drain fails and is retried before a later stream begins.
        const failed = yield* Effect.exit(flushProgress(owner));
        yield* flushProgress(owner);
        const late = yield* Effect.exit(owner.sink.emit({ _tag: "stdout", chunk: "later\n", kind: "bytes" }));
        yield* flushProgress(owner);
        // Then the failed write is not duplicated, and the drain did not close the sink.
        expect(Exit.isFailure(failed)).toBe(true);
        expect(Exit.isFailure(late)).toBe(true);
        expect(frames).toEqual([{ _tag: "stdout", chunk: "held" }]);
      }),
    );
  });
});
