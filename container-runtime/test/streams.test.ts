import { describe, expect, test } from "bun:test";

import { decodeLogStream, makeAttachDecoder, makeLogDecoder } from "@lando/container-runtime/streams";
import { Deferred, Effect, Fiber, Stream } from "effect";

const encoder = new TextEncoder();
const bytes = (value: string): Uint8Array => encoder.encode(value);
const frame = (streamType: 1 | 2, payload: string | Uint8Array): Uint8Array => {
  const body = typeof payload === "string" ? bytes(payload) : payload;
  const out = new Uint8Array(8 + body.length);
  out[0] = streamType;
  out[4] = (body.length >>> 24) & 0xff;
  out[5] = (body.length >>> 16) & 0xff;
  out[6] = (body.length >>> 8) & 0xff;
  out[7] = body.length & 0xff;
  out.set(body, 8);
  return out;
};

describe("container stream protocol helpers", () => {
  test("decodes docker/podman attach frames split across chunks", () => {
    const decode = makeAttachDecoder();
    const stdout = frame(1, "hello");
    const stderr = frame(2, "bad");
    const merged = new Uint8Array(stdout.length + stderr.length);
    merged.set(stdout);
    merged.set(stderr, stdout.length);

    expect(decode(merged.slice(0, 6))).toEqual([]);
    expect(decode(merged.slice(6))).toEqual([
      { stream: "stdout", payload: bytes("hello") },
      { stream: "stderr", payload: bytes("bad") },
    ]);
  });
});

const first = "2026-10-19T16:17:12.562061416-05:00";
const later = "2026-10-19T16:17:13.164494672-05:00";
const firstIso = "2026-10-19T21:17:12.562Z";
const laterIso = "2026-10-19T21:17:13.164Z";

describe("console log line framing", () => {
  test("reassembles captured Podman writes with per-stream timestamps and UTF-8", () => {
    const decoder = makeLogDecoder();
    const split = bytes(`${later} é done\n`);
    const prefixLength = bytes(`${later} `).length;
    const frames = [
      frame(1, `${first} is`),
      frame(1, `${later}  read`),
      frame(1, `${later} y\n`),
      frame(1, `${later}     indented\n`),
      frame(1, split.subarray(0, prefixLength + 1)),
      frame(1, new Uint8Array([...bytes(`${later} `), ...split.subarray(prefixLength + 1)])),
      frame(2, `${first} err-part`),
      frame(1, `${later} \n`),
      frame(1, `${later} tail-no-newline`),
      frame(2, `${later} ial\n`),
    ];
    const lines = frames.flatMap((chunk) => decoder.feed(chunk));
    expect(lines.map(({ stream, line, timestamp }) => [stream, line, timestamp?.toISOString()])).toEqual([
      ["stdout", "is ready", firstIso],
      ["stdout", "    indented", laterIso],
      ["stdout", "é done", laterIso],
      ["stdout", "", laterIso],
      ["stderr", "err-partial", firstIso],
    ]);
    expect(decoder.flush().map(({ line }) => line)).toEqual(["tail-no-newline"]);
    expect(decoder.flush()).toEqual([]);
  });

  test("decodes frames arriving byte-by-byte", () => {
    const decoder = makeLogDecoder();
    const input = new Uint8Array([...frame(1, `${first} par`), ...frame(1, `${later} tial\n`)]);
    const lines = [...input].flatMap((byte) => decoder.feed(Uint8Array.of(byte)));
    expect(lines.map(({ line, timestamp }) => [line, timestamp?.toISOString()])).toEqual([
      ["partial", firstIso],
    ]);
  });

  test("joins Docker 16 KiB partial messages into a single line", () => {
    const decoder = makeLogDecoder();
    expect(decoder.feed(frame(1, `${first} ${"x".repeat(16_384)}`))).toEqual([]);
    const lines = decoder.feed(frame(1, `${later} rest\n`));
    expect(lines.map(({ line, timestamp }) => [line, timestamp?.toISOString()])).toEqual([
      [`${"x".repeat(16_384)}rest`, firstIso],
    ]);
  });

  test("accepts a continuation without a timestamp", () => {
    const decoder = makeLogDecoder();
    decoder.feed(frame(1, `${first} begin`));
    expect(decoder.feed(frame(1, "ning\n")).map(({ line }) => line)).toEqual(["beginning"]);
  });

  test.each(["2026-99-99Tbad content", "not-a-date content", "2026-10-19Té content"])(
    "keeps malformed timestamp prefix as content: %s",
    (line) => {
      const decoder = makeLogDecoder();
      expect(decoder.feed(frame(1, `${line}\n`))).toEqual([{ stream: "stdout", line }]);
    },
  );

  test("ignores empty and timestamp-only frames before and during a pending line", () => {
    const decoder = makeLogDecoder();
    decoder.feed(frame(2, `${later} `));
    decoder.feed(frame(1, `${first} start`));
    decoder.feed(frame(1, ""));
    decoder.feed(frame(1, `${later} `));
    expect(
      decoder.feed(frame(1, `${later} end\n`)).map(({ line, timestamp }) => [line, timestamp?.toISOString()]),
    ).toEqual([["startend", firstIso]]);
    expect(decoder.flush()).toEqual([]);
  });

  test("strips CR when CRLF spans frames", () => {
    const decoder = makeLogDecoder();
    decoder.feed(frame(1, `${first} text\r`));
    expect(decoder.feed(frame(1, `${later} \n`)).map(({ line }) => line)).toEqual(["text"]);
  });

  test("assigns frame timestamps to subsequent lines and trailing partials", () => {
    const decoder = makeLogDecoder();
    decoder.feed(frame(1, `${first} old`));
    const lines = decoder.feed(frame(1, `${later} end\nsecond\npartial`));
    expect(lines.map(({ line, timestamp }) => [line, timestamp?.toISOString()])).toEqual([
      ["oldend", firstIso],
      ["second", laterIso],
    ]);
    expect(decoder.flush().map(({ line, timestamp }) => [line, timestamp?.toISOString()])).toEqual([
      ["partial", laterIso],
    ]);
  });

  test("flushes in first-segment arrival order rather than timestamp or stream order", () => {
    const decoder = makeLogDecoder();
    decoder.feed(frame(2, `${later} err`));
    decoder.feed(frame(1, `${first} out`));
    expect(decoder.flush().map(({ stream, line }) => [stream, line])).toEqual([
      ["stderr", "err"],
      ["stdout", "out"],
    ]);
    expect(decoder.feed(bytes("reset\n"))).toEqual([{ stream: "stdout", line: "reset" }]);
  });

  test("orders new trailing partials after older pending lines on the other stream", () => {
    const decoder = makeLogDecoder();
    decoder.feed(frame(1, "first"));
    decoder.feed(frame(2, "second"));
    decoder.feed(frame(1, " complete\nthird"));
    expect(decoder.flush().map(({ line }) => line)).toEqual(["second", "third"]);
  });

  test("buffers raw UTF-8, strips one timestamp separator and flushes trailing content", () => {
    const decoder = makeLogDecoder();
    const input = bytes(`${first}     é\npartial`);
    const lines = [...input].flatMap((byte) => decoder.feed(Uint8Array.of(byte)));
    expect(lines.map(({ line, timestamp }) => [line, timestamp?.toISOString()])).toEqual([
      ["    é", firstIso],
    ]);
    expect(decoder.flush()).toEqual([{ stream: "stdout", line: "partial" }]);
  });

  test("bounds oversized console lines without splitting them", () => {
    const decoder = makeLogDecoder();
    const lines = decoder.feed(frame(1, `${first} ${"x".repeat(65_535)}é remainder\nok\n`));
    expect(lines.map(({ line }) => line)).toEqual([`${"x".repeat(65_535)} …[truncated]`, "ok"]);
  });
});

describe("console log Stream adapter", () => {
  test("flushes on success and keeps state local to each subscription", async () => {
    const stream = decodeLogStream(Stream.make(frame(1, "partial")));
    const runs = await Effect.runPromise(Effect.all([Stream.runCollect(stream), Stream.runCollect(stream)]));
    expect(runs).toEqual([[{ stream: "stdout", line: "partial" }], [{ stream: "stdout", line: "partial" }]]);
  });

  test("does not flush after upstream failure", async () => {
    const lines: string[] = [];
    const stream = decodeLogStream(Stream.concat(Stream.make(frame(1, "partial")), Stream.fail("failed")));
    const result = await Effect.runPromise(
      Effect.result(Stream.runForEach(stream, ({ line }) => Effect.sync(() => lines.push(line)))),
    );
    expect(result._tag).toBe("Failure");
    expect(lines).toEqual([]);
  });

  test("does not flush when upstream is interrupted", async () => {
    const lines: string[] = [];
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const waiting = yield* Deferred.make<void>();
          const upstream = Stream.concat(
            Stream.make(frame(1, "partial")),
            Stream.fromEffect(Deferred.succeed(waiting, undefined)).pipe(Stream.flatMap(() => Stream.never)),
          );
          const fiber = yield* Effect.forkChild(
            Stream.runForEach(decodeLogStream(upstream), ({ line }) => Effect.sync(() => lines.push(line))),
          );
          yield* Deferred.await(waiting);
          yield* Fiber.interrupt(fiber);
        }),
      ),
    );
    expect(lines).toEqual([]);
  });

  test("never interprets incomplete multiplexed frames as trailing content", async () => {
    const stream = decodeLogStream(Stream.make(frame(1, "partial").subarray(0, 10)));
    expect(await Effect.runPromise(Stream.runCollect(stream))).toEqual([]);
  });
});
