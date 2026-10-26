import { describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";
import { flushProgress, progressFixture } from "./live-progress-fixture";

describe("MCP live progress", () => {
  test("preserves CRLF, BOM and an unterminated byte tail", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { sink, owner, text } = yield* progressFixture();
        for (const chunk of ["\ufeff", "one\r", "\n", "tail"])
          yield* sink.emit({ kind: "bytes", _tag: "stdout", chunk });
        yield* owner.finish();
        expect(text()).toBe("\ufeffone\r\ntail");
      }),
    );
  });
  test("decodes real bytes and Buffer frames across UTF-8 boundaries", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        // Given an incremental byte stream, including invalid input and a BOM.
        const { sink, owner, text, frames } = yield* progressFixture();
        // When code points span provider chunks.
        for (const chunk of [
          new Uint8Array([0xef, 0xbb]),
          Buffer.from([0xbf, 0xf0, 0x9f]),
          new Uint8Array([0x98, 0x80, 0xff, 10]),
        ]) {
          yield* sink.emit({ _tag: "stdout", chunk, kind: "bytes", source: "build" });
        }
        yield* flushProgress(owner);
        // Then replacement decoding preserves the BOM and source.
        expect(text()).toBe("\ufeff😀�\n");
        expect(frames.every((frame) => frame.source === "build")).toBe(true);
      }),
    );
  });

  test("redacts split registered secrets and drains repeatably before accepting later emits", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        // Given values registered after sink construction.
        const { sink, owner, frames, text, service } = yield* progressFixture();
        yield* service.registerValues(["private-value"]);
        // When a secret and an incomplete character straddle writes and drains.
        yield* sink.emit({ _tag: "stdout", chunk: Buffer.from("private-"), kind: "bytes" });
        yield* sink.emit({ _tag: "stdout", chunk: Buffer.from("value\n"), kind: "bytes" });
        yield* sink.emit({ _tag: "stdout", chunk: new Uint8Array([0xe2]), kind: "bytes" });
        yield* flushProgress(owner);
        const drained = text();
        yield* flushProgress(owner);
        expect(text()).toBe(drained);
        const late = yield* Effect.exit(sink.emit({ _tag: "stdout", chunk: "later", kind: "bytes" }));
        expect(Exit.isFailure(late)).toBe(true);
        yield* flushProgress(owner);
        // Then a decoder-only tail is finalized once and the drain is not a close.
        expect(text()).toBe("[redacted]\n�");
        expect(frames.length).toBeGreaterThan(1);
      }),
    );
  });

  test("delivers newline-free records immediately and drains raw mode before switching", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        // Given a held continuous tail.
        const { sink, frames, text } = yield* progressFixture();
        yield* sink.emit({ _tag: "stdout", chunk: "tail", kind: "bytes" });
        expect(frames).toHaveLength(0);
        // When a complete record arrives on that channel.
        yield* sink.emit({ _tag: "stdout", chunk: "record", kind: "record" });
        // Then both are delivered without a producer flush or newline.
        expect(text()).toBe("tailrecord\n");
        expect(frames.map((frame) => frame.chunk)).toEqual(["tail", "record\n"]);
      }),
    );
  });

  test("refreshes registered values against a previously held payload prefix", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        // Given a prefix already held by an earlier registered value.
        const { sink, owner, service, text } = yield* progressFixture();
        yield* service.registerValues(["private-longer"]);
        yield* sink.emit({ _tag: "stdout", chunk: Buffer.from("private-"), kind: "bytes" });
        // When another secret is registered before the suffix arrives.
        yield* service.registerValues(["private-value"]);
        yield* sink.emit({ _tag: "stdout", chunk: Buffer.from("value\n"), kind: "bytes" });
        yield* flushProgress(owner);
        // Then the live supplier masks the held bytes too.
        expect(text()).toBe("[redacted]\n");
      }),
    );
  });

  test("delivers byte records without requiring a newline or explicit flush", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        // Given a complete byte record, not a continuous stream.
        const { sink, frames } = yield* progressFixture();
        // When the record is emitted without raw mode.
        yield* sink.emit({ _tag: "stderr", kind: "record", chunk: "record", service: "app", source: "logs" });
        // Then it is visible immediately as text.
        expect(frames).toEqual([{ _tag: "stderr", chunk: "record\n", service: "app", source: "logs" }]);
      }),
    );
  });
  test("frames empty and oversized records with exactly one record terminator", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { sink, owner, text, frames } = yield* progressFixture();
        const record = "😀".repeat(40_000);
        yield* sink.emit({ kind: "record", _tag: "stdout", chunk: "" });
        yield* sink.emit({ kind: "record", _tag: "stdout", chunk: record });
        yield* owner.finish();
        expect(text()).toBe(`\n${record}\n`);
        expect(frames.every((frame) => Buffer.byteLength(frame.chunk) <= 65_539)).toBe(true);
      }),
    );
  });
});
