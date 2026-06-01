import { describe, expect, test } from "bun:test";

import { makeAttachDecoder, makeLogDecoder } from "@lando/container-runtime/streams";

const encoder = new TextEncoder();
const bytes = (value: string): Uint8Array => encoder.encode(value);
const frame = (streamType: 1 | 2, payload: string): Uint8Array => {
  const body = bytes(payload);
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

  test("decodes framed log lines with stdout and stderr stream ids", () => {
    const decode = makeLogDecoder({ parseLine: (stream, line) => `${stream}:${line}` });

    const chunks = decode(frame(2, "2026-01-01T00:00:00Z error\n"));

    expect(chunks).toEqual(["stderr:2026-01-01T00:00:00Z error"]);
  });

  test("buffers raw log lines until a newline arrives", () => {
    const decode = makeLogDecoder({ parseLine: (stream, line) => `${stream}:${line}` });

    expect(decode(bytes("partial"))).toEqual([]);
    expect(decode(bytes(" line\nnext\n"))).toEqual(["stdout:partial line", "stdout:next"]);
  });
});
