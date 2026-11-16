import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { McpTransportError } from "@lando/sdk/errors";
import { createRedactor } from "@lando/sdk/secrets";
import { Cause, Effect, Exit } from "effect";
import { TestClock } from "effect/testing";
import { LiveProgress } from "../src/live-progress";
import { flushProgress, progressFixture } from "./live-progress-fixture";

describe("MCP live progress", () => {
  test.each(["", " "])("cap preserves true whole-token context with separator %j", async (separator) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { sink, owner, text, service, frames } = yield* progressFixture();
        yield* service.registerValues(["wordpress"], { match: "whole-token" });
        yield* service.registerValues(["private-canary"]);
        yield* sink.emit({
          kind: "bytes",
          _tag: "stdout",
          service: "wordpress",
          source: "wordpress",
          chunk: `${"x".repeat(65536)}${separator}wordpress\nprivate-canary PASSWORD=unregistered\n`,
        });
        yield* owner.finish();
        expect(text()).toBe(
          `${"x".repeat(65536)}${separator}${separator ? "[redacted]" : "wordpress"}\n[redacted] PASSWORD=[redacted]\n`,
        );
        expect(frames.map((frame) => [frame.service, frame.source])).toEqual(
          Array.from({ length: 3 }, () => ["[redacted]", "[redacted]"]),
        );
        const retained = owner.capture.snapshot(yield* service.forProfile("secrets"));
        expect(
          retained.chunks
            .map((frame) => frame.chunk)
            .join("")
            .endsWith(
              `${separator}${separator ? "[redacted]" : "wordpress"}\n[redacted] PASSWORD=[redacted]\n`,
            ),
        ).toBe(true);
      }),
    );
  });

  test("live and retained output preserve whole-token boundaries", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { sink, owner, text, service } = yield* progressFixture();
        yield* service.registerValues(["wordpress"], { match: "whole-token" });
        yield* service.registerValues(["privateprefix"]);
        yield* sink.emit({ kind: "bytes", _tag: "stdout", chunk: "wordpress" });
        yield* sink.emit({
          kind: "bytes",
          _tag: "stdout",
          chunk: " wordpress-seo\nprivateprefixwordpress\nwordpressprivateprefix\n",
        });
        yield* owner.finish();
        const expected = "[redacted] wordpress-seo\n[redacted]wordpress\nwordpress[redacted]\n";
        expect(text()).toBe(expected);
        const redactor = yield* service.forProfile("secrets");
        expect(
          owner.capture
            .snapshot(redactor)
            .chunks.map((frame) => frame.chunk)
            .join(""),
        ).toBe(expected);
      }),
    );
  });
  test.each(["whole-token", "substring-upgrade"] as const)(
    "fails closed when a late %s registration follows a value-layer rewrite",
    async (mode) => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const { sink, owner, service, text } = yield* progressFixture();
          yield* service.registerValues(["privateprefix"]);
          if (mode === "substring-upgrade")
            yield* service.registerValues(["wordpress"], { match: "whole-token" });
          yield* sink.emit({
            kind: "bytes",
            _tag: "stdout",
            chunk: "wordpress\nwordpress-seo\nprivateprefixwordpress\nwordpressprivateprefix\n",
          });
          yield* owner.finish();
          expect(text()).toBe(
            `${mode === "whole-token" ? "wordpress" : "[redacted]"}\nwordpress-seo\n[redacted]wordpress\nwordpress[redacted]\n`,
          );
          yield* service.registerValues(["wordpress"], {
            match: mode === "whole-token" ? "whole-token" : "substring",
          });
          const retained = owner.capture.snapshot(yield* service.forProfile("secrets"));
          // The live chunks already lost their original bytes, so a late value
          // cannot be replayed safely: retained capture fails closed.
          expect(retained).toEqual({ chunks: [], truncated: true });
        }),
      );
    },
  );
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

describe("MCP live time bound", () => {
  test("holds a split quoted record until the deadline and emits one masked frame", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        // Given
        const { sink, owner, frames } = yield* progressFixture();
        // When
        yield* sink.emit({
          kind: "record",
          _tag: "stderr",
          chunk: 'password="first',
          service: "app",
          source: "logs",
        });
        yield* TestClock.adjust(499);
        expect(frames).toEqual([]);
        yield* TestClock.adjust(1);
        expect(frames).toEqual([
          { _tag: "stderr", chunk: "password=[redacted]\n", service: "app", source: "logs" },
        ]);
        yield* TestClock.adjust(5_000);
        // Then no later clock advance changes the frame.
        expect(frames).toHaveLength(1);
        yield* owner.finish();
      }).pipe(Effect.provide(TestClock.layer())),
    );
  });

  test("masks a Bearer token that arrives after its introducer expired", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        // Given an introducer whose token is on a later record.
        const { sink, owner, frames } = yield* progressFixture();
        yield* sink.emit({
          kind: "record",
          _tag: "stderr",
          chunk: "Authorization: Bearer",
          service: "app",
          source: "logs",
        });
        yield* TestClock.adjust(499);
        expect(frames).toEqual([]);
        // When the deadline releases the introducer and the token record arrives.
        yield* TestClock.adjust(1);
        yield* sink.emit({
          kind: "record",
          _tag: "stderr",
          chunk: "   eyJhbGciOi.abc-123 rest",
          service: "app",
          source: "logs",
        });
        // Then only the token is masked and the rest of its record is kept.
        expect(frames).toEqual([
          { _tag: "stderr", chunk: "Authorization: Bearer\n", service: "app", source: "logs" },
          { _tag: "stderr", chunk: "[redacted] rest\n", service: "app", source: "logs" },
        ]);
        yield* owner.finish();
      }).pipe(Effect.provide(TestClock.layer())),
    );
  });

  test("completes two records inside the window as one masked frame", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        // Given
        const { sink, owner, frames } = yield* progressFixture();
        // When
        yield* sink.emit({ kind: "record", _tag: "stdout", chunk: 'password="a', service: "app" });
        yield* TestClock.adjust(499);
        yield* sink.emit({ kind: "record", _tag: "stdout", chunk: 'b"', service: "app" });
        // Then
        expect(frames).toEqual([{ _tag: "stdout", chunk: "password=[redacted]\n", service: "app" }]);
        yield* owner.finish();
      }).pipe(Effect.provide(TestClock.layer())),
    );
  });

  test("masks a registered multi-line value across records", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        // Given
        const { sink, owner, service, text } = yield* progressFixture();
        yield* service.registerValues(["left\nright"]);
        // When
        yield* sink.emit({ kind: "record", _tag: "stdout", chunk: "before left", service: "app" });
        yield* sink.emit({ kind: "record", _tag: "stdout", chunk: "right after", service: "app" });
        yield* owner.finish();
        // Then
        expect(text()).toBe("before [redacted] after\n");
      }).pipe(Effect.provide(TestClock.layer())),
    );
  });

  test("expires a withheld registered-value prefix and releases its line once", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        // Given a registered value whose newline is withheld with its prefix.
        const { sink, owner, service, frames } = yield* progressFixture();
        yield* service.registerValues(["left\nright"]);
        // When the record's prefix is held and the deadline passes.
        yield* sink.emit({ kind: "record", _tag: "stdout", chunk: "before left" });
        yield* TestClock.adjust(499);
        expect(frames).toEqual([]);
        yield* TestClock.adjust(1);
        // Then the committed prefix is masked as one line.
        expect(frames).toEqual([{ _tag: "stdout", chunk: "before [redacted]\n" }]);
        yield* owner.finish();
      }).pipe(Effect.provide(TestClock.layer())),
    );
  });

  test("finish flushes a held record and later clock advances emit nothing", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        // Given
        const { sink, owner, frames } = yield* progressFixture();
        yield* sink.emit({ kind: "record", _tag: "stdout", chunk: 'password="first' });
        // When
        yield* owner.finish();
        expect(frames).toEqual([{ _tag: "stdout", chunk: "password=[redacted]\n" }]);
        yield* TestClock.adjust(5_000);
        yield* owner.finish();
        // Then
        expect(frames).toEqual([{ _tag: "stdout", chunk: "password=[redacted]\n" }]);
      }).pipe(Effect.provide(TestClock.layer())),
    );
  });

  test("holds an open byte line until a newline completes it", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        // Given a byte channel whose open quoted value has no newline yet.
        const { sink, owner, frames } = yield* progressFixture();
        yield* sink.emit({ kind: "bytes", _tag: "stdout", chunk: Buffer.from('password="first') });
        yield* TestClock.adjust(500);
        expect(frames).toEqual([]);
        // When the producer completes the line.
        yield* sink.emit({ kind: "bytes", _tag: "stdout", chunk: Buffer.from('second"\n') });
        // Then the whole line is masked once.
        expect(frames).toEqual([{ _tag: "stdout", chunk: "password=[redacted]\n" }]);
        yield* owner.finish();
      }).pipe(Effect.provide(TestClock.layer())),
    );
  });
});

test("a line released by a payload expiry masks at the payload deadline", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      // Given a registered multi-line value whose newline the value layer withholds.
      const { sink, owner, frames, service } = yield* progressFixture();
      yield* service.registerValues(["left\nright"]);
      yield* sink.emit({ kind: "bytes", _tag: "stdout", chunk: Buffer.from('password="left\n') });
      expect(frames).toEqual([]);
      // When the payload deadline passes, the still-open line keeps the original start.
      yield* TestClock.adjust(500);
      // Then it is masked at 500 ms, not after a second full window.
      expect(frames).toEqual([{ _tag: "stdout", chunk: "password=[redacted]\n" }]);
      yield* owner.finish();
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

test("counts undelivered queued chunks against the retained byte budget", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      // Given a client that never commits a delivery.
      const live = new LiveProgress(
        () => [],
        () =>
          Effect.sync(() => {
            throw new Error("stalled client");
          }),
        { redactor: createRedactor("secrets"), now: () => 0 },
      );
      const record = "h".repeat(65_536);
      let failed = false;
      for (let index = 0; index < 200 && !failed; index += 1) {
        const exit = yield* Effect.exit(live.emit({ kind: "record", _tag: "stdout", chunk: record }));
        if (Exit.isFailure(exit) && Cause.squash(exit.cause) instanceof McpTransportError) failed = true;
      }
      // Then queued bytes cross the fail-closed limit instead of accumulating unseen.
      expect(failed).toBe(true);
    }),
  );
});
