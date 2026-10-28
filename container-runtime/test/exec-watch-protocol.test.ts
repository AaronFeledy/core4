import { describe, expect, test } from "bun:test";
import {
  ExecWatchAttachDecoder,
  ExecWatchProtocol,
  ExecWatchProtocolError,
  type ExecWatchReceipt,
} from "../src/exec-watch-protocol.ts";

const bytes = (value: string) => new TextEncoder().encode(value);
const line = (value: unknown) => bytes(`${JSON.stringify(value)}\n`);
const ready = (seq = 1) => ({ ok: true, seq, state: "ready" }) as const;
const running = (seq = 2) => ({ ok: true, seq, state: "running" }) as const;
const finished = (seq = 2, exitCode = 0) =>
  ({ ok: true, seq, state: "finished", joined: true, exitCode }) as const;
const cancelled = (seq = 1) => ({ ok: true, seq, state: "cancelled", joined: true }) as const;
const concat = (...parts: readonly Uint8Array[]): Uint8Array => {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
};
const frame = (payload: Uint8Array, stream = 1, declaredLength = payload.length) => {
  const header = new Uint8Array(8);
  header[0] = stream;
  new DataView(header.buffer).setUint32(4, declaredLength);
  return concat(header, payload);
};
const harness = () => {
  const receipts: ExecWatchReceipt[] = [];
  const protocol = new ExecWatchProtocol((receipt) => receipts.push(receipt));
  const decoder = new ExecWatchAttachDecoder(protocol);
  return { protocol, decoder, receipts };
};
const launched = () => {
  const h = harness();
  h.protocol.request();
  h.protocol.feed(line(ready()));
  h.protocol.markLaunched();
  h.protocol.request();
  return h;
};

describe("private exec watch request and receipt ordering", () => {
  test("allows exactly one outstanding status request with increasing safe sequence numbers", () => {
    const h = harness();
    expect(JSON.parse(new TextDecoder().decode(h.protocol.request()))).toEqual({ op: "status", seq: 1 });
    expect(() => h.protocol.request()).toThrow(ExecWatchProtocolError);
    h.protocol.feed(line(ready()));
    h.protocol.markLaunched();
    expect(JSON.parse(new TextDecoder().decode(h.protocol.request()))).toEqual({ op: "status", seq: 2 });
    h.protocol.feed(line(running()));
    expect(JSON.parse(new TextDecoder().decode(h.protocol.request()))).toEqual({ op: "status", seq: 3 });
    h.protocol.feed(line(finished(3, 23)));
    expect(h.protocol.end()).toEqual(finished(3, 23));
    expect(h.receipts).toEqual([ready(), running(), finished(3, 23)]);
    expect(() => h.protocol.request()).toThrow(ExecWatchProtocolError);
  });

  test("rejects an unsolicited reply before the first pulse", () => {
    const h = harness();
    expect(() => h.protocol.feed(line(ready()))).toThrow(ExecWatchProtocolError);
    expect(h.receipts).toHaveLength(0);
  });

  test("rejects unsolicited partial bytes before a pulse and between receipts", () => {
    const before = harness();
    expect(() => before.protocol.feed(bytes("{"))).toThrow(ExecWatchProtocolError);
    const between = harness();
    between.protocol.request();
    between.protocol.feed(line(ready()));
    expect(() => between.protocol.feed(bytes("{"))).toThrow(ExecWatchProtocolError);
    expect(between.receipts).toEqual([ready()]);
  });

  test.each([0, 2, 3, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1", null])(
    "rejects a reply whose sequence does not match the pending pulse: %s",
    (seq) => {
      const h = harness();
      h.protocol.request();
      expect(() => h.protocol.feed(line({ ...ready(), seq }))).toThrow(ExecWatchProtocolError);
      expect(h.receipts).toHaveLength(0);
    },
  );

  test("rejects a delayed duplicate after a later request becomes pending", () => {
    const h = launched();
    expect(() => h.protocol.feed(line(running(1)))).toThrow(ExecWatchProtocolError);
    expect(h.receipts).toEqual([ready()]);
  });

  test.each([
    '{"ok":true,"seq":1,"seq":2,"state":"running"}',
    '{"ok":true,"seq":2,"seq":2,"state":"running"}',
    '{"ok":false,"ok":true,"seq":2,"state":"running"}',
    '{"ok":true,"seq":2,"state":"ready","state":"running"}',
    '{"ok":true,"seq":2,"state":"running","state":"running"}',
    '{"ok":true,"seq":2,"state":"finished","joined":false,"joined":true,"exitCode":0}',
    '{"ok":true,"seq":2,"state":"finished","joined":true,"exitCode":256,"exitCode":0}',
  ])("rejects duplicate JSON fields before last-value parsing can hide an invalid receipt: %#", (input) => {
    expect(JSON.parse(input)).toMatchObject({ ok: true, seq: 2 });
    const h = launched();
    expect(() => h.protocol.feed(bytes(`${input}\n`))).toThrow(ExecWatchProtocolError);
    expect(h.receipts).toEqual([ready()]);
  });

  test.each([
    String.raw`{"ok":true,"s\u0065q":2,"state":"running"}`,
    String.raw`{"ok":true,"seq":1,"\u0073eq":2,"state":"running"}`,
    String.raw`{"\u006fk":true,"seq":2,"state":"running"}`,
    String.raw`{"ok":true,"seq":2,"st\u0061te":"running"}`,
    String.raw`{"ok":true,"seq":2,"state":"r\u0075nning"}`,
    String.raw`{"ok":true,"seq":2,"state":"finished","jo\u0069ned":true,"exitCode":0}`,
    String.raw`{"ok":true,"seq":2,"state":"finished","joined":true,"exit\u0043ode":0}`,
  ])("rejects escaped field names and enum literals in canonical private receipts: %#", (input) => {
    expect(JSON.parse(input)).toMatchObject({ ok: true, seq: 2 });
    const h = launched();
    expect(() => h.protocol.feed(bytes(`${input}\n`))).toThrow(ExecWatchProtocolError);
    expect(h.receipts).toEqual([ready()]);
  });

  test("rejects duplicate and pre-sent future replies in the same feed", () => {
    for (const second of [ready(), running(2)]) {
      const h = harness();
      h.protocol.request();
      expect(() => h.protocol.feed(concat(line(ready()), line(second)))).toThrow(ExecWatchProtocolError);
      expect(h.receipts).toHaveLength(0);
    }
  });

  test("does not authorize launch before a confirmed READY receipt or while a request is pending", () => {
    const h = harness();
    expect(() => h.protocol.markLaunched()).toThrow(ExecWatchProtocolError);
    h.protocol.request();
    expect(() => h.protocol.markLaunched()).toThrow(ExecWatchProtocolError);
    h.protocol.feed(line(ready()));
    h.protocol.request();
    expect(() => h.protocol.markLaunched()).toThrow(ExecWatchProtocolError);
  });

  test("requires READY before launch and rejects READY after launch", () => {
    const initial = harness();
    initial.protocol.request();
    expect(() => initial.protocol.feed(line(running(1)))).toThrow(ExecWatchProtocolError);
    const afterLaunch = launched();
    expect(() => afterLaunch.protocol.feed(line(ready(2)))).toThrow(ExecWatchProtocolError);
  });

  test("cancellation accepts joined cancellation before READY or a joined result after launch", () => {
    const before = harness();
    before.protocol.beginCancel();
    before.protocol.request();
    before.protocol.feed(line(cancelled()));
    expect(before.protocol.end()).toEqual(cancelled());
    const after = launched();
    after.protocol.beginCancel();
    after.protocol.feed(line(finished(2, 143)));
    expect(after.protocol.end()).toEqual(finished(2, 143));
  });

  test.each(["initialized", "collected", "unknown", "", null, 1])(
    "rejects an invalid watch state: %s",
    (state) => {
      const h = harness();
      h.protocol.request();
      expect(() => h.protocol.feed(line({ ...ready(), state }))).toThrow(ExecWatchProtocolError);
      expect(h.receipts).toHaveLength(0);
    },
  );

  const malformedReceipts: ReadonlyArray<{ readonly seq: number } & Readonly<Record<string, unknown>>> = [
    { seq: 1, state: "ready" },
    { ok: false, seq: 1, state: "ready" },
    { ...ready(), joined: true },
    { ...ready(), joined: false },
    { ...ready(), exitCode: 0 },
    { ...running(), joined: true },
    { ...running(), exitCode: 0 },
    { ok: true, seq: 2, state: "finished", joined: true },
    { ...finished(), joined: false },
    { ...finished(), joined: undefined },
    { ...finished(), exitCode: -1 },
    { ...finished(), exitCode: 256 },
    { ...finished(), exitCode: 1.5 },
    { ...finished(), exitCode: "0" },
    { ...cancelled(2), joined: false },
    { ...cancelled(2), joined: undefined },
    { ...cancelled(2), exitCode: 0 },
  ];
  test.each(malformedReceipts)("rejects malformed receipt semantics %#", (reply) => {
    const h = reply.seq === 1 ? harness() : launched();
    if (reply.seq === 1) h.protocol.request();
    expect(() => h.protocol.feed(line(reply))).toThrow(ExecWatchProtocolError);
  });

  test.each([
    "\n",
    " \n",
    "null\n",
    "[]\n",
    "{}\n",
    "{oops}\n",
    '{"ok":true}\n',
    `${JSON.stringify(ready())}suffix\n`,
  ])("rejects malformed or blank JSONL: %#", (input) => {
    const h = harness();
    h.protocol.request();
    expect(() => h.protocol.feed(bytes(input))).toThrow(ExecWatchProtocolError);
    expect(h.receipts).toHaveLength(0);
  });

  test("requires ASCII even when a non-ASCII JSON string is otherwise parseable", () => {
    const h = harness();
    h.protocol.request();
    expect(() => h.protocol.feed(line({ ...ready(), unexpected: "é" }))).toThrow(ExecWatchProtocolError);
  });

  test("rejects declared helper failures and unknown receipt fields without forwarding them", () => {
    for (const reply of [
      { ok: false, seq: 1, error: "control-unavailable" },
      { ok: false, seq: 1, error: "arbitrary error details" },
      { ...ready(), error: "unexpected-success-error" },
      { ...ready(), extra: true },
    ]) {
      const h = harness();
      h.protocol.request();
      expect(() => h.protocol.feed(line(reply))).toThrow(ExecWatchProtocolError);
      expect(h.receipts).toHaveLength(0);
    }
  });

  test("bounds a single unterminated line and complete oversized JSON without a cumulative stream cap", () => {
    const partial = harness();
    partial.protocol.request();
    expect(() => partial.protocol.feed(bytes(`{"${"x".repeat(4096)}`))).toThrow(ExecWatchProtocolError);
    const whole = harness();
    whole.protocol.request();
    expect(() => whole.protocol.feed(line({ ...ready(), excess: "x".repeat(4096) }))).toThrow(
      ExecWatchProtocolError,
    );
    const longLived = launched();
    for (let seq = 2; seq < 1000; seq++) {
      if (seq !== 2) longLived.protocol.request();
      longLived.protocol.feed(line(running(seq)));
    }
    longLived.protocol.request();
    longLived.protocol.feed(line(finished(1000)));
    expect(longLived.protocol.end()).toEqual(finished(1000));
    expect(longLived.receipts).toHaveLength(1000);
  });

  test("EOF rejects missing terminal state, pending requests and partial raw JSON", () => {
    expect(() => harness().protocol.end()).toThrow(ExecWatchProtocolError);
    const pending = harness();
    pending.protocol.request();
    expect(() => pending.protocol.end()).toThrow(ExecWatchProtocolError);
    const nonterminal = harness();
    nonterminal.protocol.request();
    nonterminal.protocol.feed(line(ready()));
    expect(() => nonterminal.protocol.end()).toThrow(ExecWatchProtocolError);
    const partial = launched();
    partial.protocol.feed(bytes(JSON.stringify(finished())));
    expect(() => partial.protocol.end()).toThrow(ExecWatchProtocolError);
  });
});

describe("private exec watch raw and Docker attach framing", () => {
  test.each([
    { name: "raw junk", input: concat(line(ready()), bytes("junk")) },
    { name: "raw partial JSON", input: concat(line(ready()), bytes("{")) },
    { name: "raw blank line", input: concat(line(ready()), bytes("\n")) },
    { name: "raw future reply", input: concat(line(ready()), line(running(2))) },
    { name: "Docker one-byte header", input: concat(frame(line(ready())), Uint8Array.of(1)) },
    { name: "Docker partial header", input: concat(frame(line(ready())), Uint8Array.of(1, 0, 0)) },
    {
      name: "Docker header without payload",
      input: concat(frame(line(ready())), frame(bytes("x")).subarray(0, 8)),
    },
    { name: "Docker future reply", input: concat(frame(line(ready())), frame(line(running(2)))) },
    { name: "Docker unknown stream", input: concat(frame(line(ready())), frame(bytes("x"), 3)) },
  ])("never publishes READY before rejecting same-chunk $name", ({ input }) => {
    const h = harness();
    h.protocol.request();
    expect(() => h.decoder.feed(input)).toThrow(ExecWatchProtocolError);
    expect(h.receipts).toHaveLength(0);
  });

  test.each(["ready", "finished", "cancelled"] as const)(
    "never publishes %s when a Docker frame declares bytes after its complete reply",
    (state) => {
      const reply = state === "ready" ? ready() : state === "finished" ? finished(1) : cancelled();
      const payload = line(reply);
      for (const missingBytes of [1, 7, 64]) {
        const h = harness();
        if (state !== "ready") h.protocol.beginCancel();
        h.protocol.request();
        // The complete JSON line is present, but the same Docker payload promises a suffix.
        expect(() => h.decoder.feed(frame(payload, 1, payload.length + missingBytes))).toThrow(
          ExecWatchProtocolError,
        );
        expect(h.receipts).toHaveLength(0);
      }
    },
  );

  test.each(["raw", "docker"] as const)("reassembles %s terminal receipt at every split boundary", (mode) => {
    const payload = line(finished(1, 255));
    const input = mode === "raw" ? payload : frame(payload);
    for (let split = 0; split <= input.length; split++) {
      const h = harness();
      h.protocol.beginCancel();
      h.protocol.request();
      h.decoder.feed(input.subarray(0, split));
      h.decoder.feed(input.subarray(split));
      expect(h.decoder.end()).toEqual(finished(1, 255));
      expect(h.receipts).toEqual([finished(1, 255)]);
    }
  });

  test("accepts coalesced Docker frames and one-byte header/payload fragmentation", () => {
    const payload = line(cancelled());
    const input = concat(
      frame(payload.subarray(0, 3)),
      frame(payload.subarray(3, 23)),
      frame(payload.subarray(23)),
    );
    for (const fragmented of [false, true]) {
      const h = harness();
      h.protocol.beginCancel();
      h.protocol.request();
      for (const chunk of fragmented ? [...input].map((byte) => Uint8Array.of(byte)) : [input])
        h.decoder.feed(chunk);
      expect(h.decoder.end()).toEqual(cancelled());
      expect(h.receipts).toEqual([cancelled()]);
    }
  });

  test.each([0, 2, 3, 255])("rejects stderr and unknown Docker stream IDs: %s", (stream) => {
    const h = harness();
    h.protocol.request();
    expect(() => {
      h.decoder.feed(frame(line(ready()), stream));
      h.decoder.end();
    }).toThrow(ExecWatchProtocolError);
    expect(h.receipts).toHaveLength(0);
  });

  test.each([1, 2, 3])("rejects nonzero Docker padding byte %s", (paddingOffset) => {
    const h = harness();
    h.protocol.request();
    const input = frame(line(ready()));
    input[paddingOffset] = 1;
    expect(() => h.decoder.feed(input)).toThrow(ExecWatchProtocolError);
    expect(h.receipts).toHaveLength(0);
  });

  test("rejects excessive Docker payload length from the header before buffering its body", () => {
    const h = harness();
    h.protocol.request();
    expect(() => h.decoder.feed(frame(new Uint8Array(), 1, 4098))).toThrow(ExecWatchProtocolError);
    const huge = harness();
    huge.protocol.request();
    expect(() => huge.decoder.feed(frame(new Uint8Array(), 1, 0xffff_ffff))).toThrow(ExecWatchProtocolError);
  });

  test("EOF rejects every incomplete Docker header and payload", () => {
    for (let length = 1; length < 8; length++) {
      const h = harness();
      h.protocol.request();
      h.decoder.feed(frame(line(ready())).subarray(0, length));
      expect(() => h.decoder.end()).toThrow(ExecWatchProtocolError);
    }
    const h = harness();
    h.protocol.request();
    h.decoder.feed(frame(line(ready())).subarray(0, -1));
    expect(() => h.decoder.end()).toThrow(ExecWatchProtocolError);
    expect(h.receipts).toHaveLength(0);
  });

  test.each(["raw", "docker"] as const)("rejects every kind of post-terminal %s suffix", (mode) => {
    const terminal = line(cancelled());
    const first = mode === "raw" ? terminal : frame(terminal);
    const suffixes =
      mode === "raw"
        ? [bytes("\n"), bytes(" "), bytes("x"), bytes("{"), line(cancelled()), bytes("\0")]
        : [
            frame(bytes("\n")),
            frame(line(cancelled())),
            frame(new Uint8Array()),
            frame(bytes("x")),
            Uint8Array.of(1),
            frame(bytes("x")).subarray(0, 8),
          ];
    for (const suffix of suffixes) {
      for (const coalesced of [false, true]) {
        const h = harness();
        h.protocol.beginCancel();
        h.protocol.request();
        expect(() => {
          if (coalesced) h.decoder.feed(concat(first, suffix));
          else {
            h.decoder.feed(first);
            h.decoder.feed(suffix);
          }
          h.decoder.end();
        }).toThrow(ExecWatchProtocolError);
        expect(h.receipts).toHaveLength(coalesced ? 0 : 1);
      }
    }
  });

  test("does not accept a valid Docker reply when another frame has a truncated payload", () => {
    const h = harness();
    h.protocol.beginCancel();
    h.protocol.request();
    expect(() => {
      h.decoder.feed(concat(frame(line(cancelled())), frame(bytes("x"), 1, 2)));
      h.decoder.end();
    }).toThrow(ExecWatchProtocolError);
  });

  test("cannot mix raw JSONL and Docker framing in one watch", () => {
    const h = harness();
    h.protocol.request();
    h.decoder.feed(line(ready()));
    h.protocol.markLaunched();
    h.protocol.request();
    expect(() => h.decoder.feed(frame(line(finished())))).toThrow(ExecWatchProtocolError);
  });

  test.each(["raw", "docker"] as const)(
    "rejects %s bytes received after successful EOF validation",
    (mode) => {
      const h = harness();
      h.protocol.beginCancel();
      h.protocol.request();
      h.decoder.feed(mode === "raw" ? line(cancelled()) : frame(line(cancelled())));
      expect(h.decoder.end()).toEqual(cancelled());
      expect(() => {
        h.decoder.feed(mode === "raw" ? bytes("{") : Uint8Array.of(1));
        h.decoder.end();
      }).toThrow(ExecWatchProtocolError);
    },
  );
});
