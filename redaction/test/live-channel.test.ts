import { describe, expect, test } from "bun:test";
import { createRedactor } from "@lando/sdk/secrets";
import { createLiveChannel } from "../src/live-channel.ts";

const encoder = new TextEncoder();

const liveClock = (start = 1_000) => {
  let current = start;
  return {
    timeBound: { maxHeldMillis: 500, now: () => current },
    advance: (millis: number) => {
      current += millis;
    },
  };
};

describe("live channel payload hold", () => {
  test("clears the payload hold when a later write resolves the pending prefix", () => {
    // Given a registered multi-line value whose prefix the value layer withholds.
    const clock = liveClock();
    const values = ["left\nright"];
    const channel = createLiveChannel({
      kind: "bytes",
      redactor: createRedactor("secrets", { values }),
      payloadValues: () => values,
      timeBound: clock.timeBound,
    });
    expect(channel.feed(encoder.encode("before left\n"))).toEqual(new Uint8Array(0));
    expect(channel.queue).toEqual([]);
    expect(channel.deadline()).toBe(1_500);
    // When the continuation completes the value inside the window.
    clock.advance(100);
    channel.feed(encoder.encode("right after\n"));
    // The value layer rewrote the bytes, so retained capture must fail closed.
    expect(channel.queue).toEqual([{ chunk: "before [redacted] after\n", changed: true }]);
    expect(channel.deadline()).toBeUndefined();
    channel.shift();
    // Then a new pending prefix starts its own window instead of inheriting the old start.
    clock.advance(500);
    channel.feed(encoder.encode("before left\n"));
    expect(channel.queue).toEqual([]);
    expect(channel.deadline()).toBe(2_100);
    channel.expire();
    expect(channel.queue).toEqual([]);
    // And it fails closed only at its own deadline.
    clock.advance(499);
    channel.expire();
    expect(channel.queue).toEqual([]);
    clock.advance(1);
    channel.expire();
    expect(channel.queue).toEqual([{ chunk: "before [redacted]\n", changed: true }]);
    expect(channel.deadline()).toBeUndefined();
  });
});

describe("live channel time bound", () => {
  test("a line released by a payload expiry fails closed at the payload deadline", () => {
    // Given a registered value whose newline the value layer withholds.
    const clock = liveClock();
    const values = ["left\nright"];
    const channel = createLiveChannel({
      kind: "bytes",
      redactor: createRedactor("secrets", { values }),
      payloadValues: () => values,
      timeBound: clock.timeBound,
    });
    expect(channel.feed(encoder.encode('password="left\n'))).toEqual(new Uint8Array(0));
    expect(channel.queue).toEqual([]);
    expect(channel.deadline()).toBe(1_500);
    // When the payload hold expires, the still-open line keeps the original start.
    clock.advance(500);
    channel.expire();
    // Then it is masked at 500 ms, not after a second full window at 1000 ms.
    expect(channel.queue).toEqual([{ chunk: "password=[redacted]\n", changed: true }]);
    expect(channel.deadline()).toBeUndefined();
  });
});

describe("live channel retained bytes", () => {
  test("counts chunks queued but not yet delivered", () => {
    // Given a delivered chunk the sink has not committed or shifted.
    const values = ["hunter2"];
    const channel = createLiveChannel({
      kind: "bytes",
      redactor: createRedactor("secrets", { values }),
      payloadValues: () => values,
    });
    channel.feed(encoder.encode("hunter2\n"));
    expect(channel.queue).toHaveLength(1);
    // Then the budget sees the queued bytes, so a stalled client cannot grow memory
    // past the fail-closed limit.
    expect(channel.retainedBytes()).toBe(encoder.encode("[redacted]\n").length);
    channel.shift();
    expect(channel.retainedBytes()).toBe(0);
  });
});

describe("live channel payload hold start", () => {
  const drain = (channel: {
    readonly queue: readonly { readonly chunk: string }[];
    readonly shift: () => void;
  }): string[] => {
    const chunks: string[] = [];
    while (channel.queue.length > 0) {
      const head = channel.queue[0];
      if (head !== undefined) chunks.push(head.chunk);
      channel.shift();
    }
    return chunks;
  };

  test("a record write that resolves the payload hold keeps its start for the line hold", () => {
    // Given a registered value whose newline the value layer withholds.
    const clock = liveClock();
    const values = ["left\nright"];
    const channel = createLiveChannel({
      kind: "record",
      redactor: createRedactor("secrets", { values }),
      payloadValues: () => values,
      timeBound: clock.timeBound,
    });
    channel.feed('password="left');
    expect(channel.deadline()).toBe(1_500);
    // When a later record resolves the value and its bytes open a quoted line.
    clock.advance(400);
    channel.feed("right");
    // Then the line hold keeps the payload hold's start instead of a second window.
    expect(channel.deadline()).toBe(1_500);
    clock.advance(100);
    channel.expire();
    expect(drain(channel)).toEqual(["password=[redacted]\n"]);
  });

  test("a byte write that resolves the payload hold keeps its start for the line hold", () => {
    // Given a registered value whose newline the value layer withholds.
    const clock = liveClock();
    const values = ["left\nright"];
    const channel = createLiveChannel({
      kind: "bytes",
      redactor: createRedactor("secrets", { values }),
      payloadValues: () => values,
      timeBound: clock.timeBound,
    });
    channel.feed(encoder.encode('password="left\n'));
    expect(channel.deadline()).toBe(1_500);
    // When a later write resolves the value and its bytes open a quoted line.
    clock.advance(400);
    channel.feed(encoder.encode("right\n"));
    // Then the line hold keeps the payload hold's start instead of a second window.
    expect(channel.deadline()).toBe(1_500);
    clock.advance(100);
    channel.expire();
    expect(drain(channel)).toEqual(["password=[redacted]\n"]);
  });
});

describe("live channel continuation suppression", () => {
  const drain = (channel: {
    readonly queue: readonly { readonly chunk: string }[];
    readonly shift: () => void;
  }): string[] => {
    const chunks: string[] = [];
    while (channel.queue.length > 0) {
      const head = channel.queue[0];
      if (head !== undefined) chunks.push(head.chunk);
      channel.shift();
    }
    return chunks;
  };

  test("a cut piece inside a released value stays suppressed until the closer arrives", () => {
    // Given a quoted value released fail-closed at the time bound.
    const clock = liveClock();
    const channel = createLiveChannel({
      kind: "bytes",
      redactor: createRedactor("secrets"),
      payloadValues: () => [],
      timeBound: clock.timeBound,
      maxPieceBytes: 32,
    });
    channel.feed(encoder.encode('password="a\n'));
    clock.advance(500);
    channel.expire();
    expect(drain(channel)).toEqual(["password=[redacted]\n"]);
    // When a piece cut at the piece cap continues the value, it is dropped.
    channel.feed(encoder.encode("b".repeat(40)));
    expect(drain(channel)).toEqual([]);
    // Then the line carrying the closer contributes nothing, and later lines flow.
    channel.feed(encoder.encode('tail"\n'));
    expect(drain(channel)).toEqual([]);
    channel.feed(encoder.encode("public\n"));
    expect(drain(channel)).toEqual(["public\n"]);
  });

  test("an unterminated tail after a released value is suppressed at end of stream", () => {
    // Given a released value whose continuation is still open.
    const clock = liveClock();
    const channel = createLiveChannel({
      kind: "bytes",
      redactor: createRedactor("secrets"),
      payloadValues: () => [],
      timeBound: clock.timeBound,
    });
    channel.feed(encoder.encode('password="a\n'));
    clock.advance(500);
    channel.expire();
    expect(drain(channel)).toEqual(["password=[redacted]\n"]);
    // When a partial line arrives and the stream ends.
    channel.feed(encoder.encode("still-inside"));
    channel.end();
    // Then nothing of the value's tail is delivered.
    expect(drain(channel)).toEqual([]);
  });

  test("a closer reached in a fragment resumes output at the remainder", () => {
    // Given a released value.
    const clock = liveClock();
    const channel = createLiveChannel({
      kind: "bytes",
      redactor: createRedactor("secrets"),
      payloadValues: () => [],
      timeBound: clock.timeBound,
      maxPieceBytes: 32,
    });
    channel.feed(encoder.encode('password="a\n'));
    clock.advance(500);
    channel.expire();
    expect(drain(channel)).toEqual(["password=[redacted]\n"]);
    // When the closer arrives inside a piece cut at the cap, with a suffix.
    channel.feed(encoder.encode(`b" tail-${"x".repeat(30)}`));
    // Then only the remainder after the whole value is delivered.
    const delivered = drain(channel);
    expect(delivered.join("")).toBe(` tail-${"x".repeat(24)}`);
    channel.end();
    delivered.push(...drain(channel));
    expect(delivered.join("")).toBe(` tail-${"x".repeat(30)}`);
  });
});
