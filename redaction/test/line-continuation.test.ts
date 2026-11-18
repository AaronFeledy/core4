import { describe, expect, test } from "bun:test";
import {
  createLineStreamRedactor,
  createOutputLineRedactor,
  redactLineSequence,
} from "@lando/redaction/line-stream";
import { createLiveChannel } from "@lando/redaction/live-channel";
import { createRedactor } from "@lando/sdk/secrets";

const encoder = new TextEncoder();

const clock = () => {
  let current = 1_000;
  return {
    timeBound: { maxHeldMillis: 500, now: () => current },
    advance: (millis: number) => {
      current += millis;
    },
  };
};

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

describe("line continuation: a released Bearer introducer", () => {
  test("masks a Bearer token that arrives after its introducer was released", () => {
    // Given an introducer released fail-closed on the time bound.
    const time = clock();
    const stream = createLineStreamRedactor(createRedactor("secrets"), { timeBound: time.timeBound });
    expect(stream.push("Authorization: Bearer")).toEqual([]);
    time.advance(500);
    expect(stream.expire()).toEqual(["Authorization: Bearer"]);
    // When blank lines separate the introducer from its token, they are skipped.
    expect(stream.push("   ")).toEqual([]);
    expect(stream.push("")).toEqual([]);
    // Then the first token run is masked and the rest of that line is kept.
    expect(stream.push("   eyJhbGciOi.abc-123 rest")).toEqual(["[redacted] rest"]);
    expect(stream.push("public")).toEqual(["public"]);
  });

  test("a prose word after a released Bearer introducer ends suppression untouched", () => {
    // Given an introducer released fail-closed.
    const time = clock();
    const stream = createLineStreamRedactor(createRedactor("secrets"), { timeBound: time.timeBound });
    expect(stream.push("Authorization: Bearer")).toEqual([]);
    time.advance(500);
    expect(stream.expire()).toEqual(["Authorization: Bearer"]);
    // When the value turns out to be prose, the line flows as written.
    expect(stream.push("token expected in the Authorization header")).toEqual([
      "token expected in the Authorization header",
    ]);
    expect(stream.push("public")).toEqual(["public"]);
  });

  test("a released Bearer introducer that never gets a token ends suppression at the bound", () => {
    // Given a released introducer and only whitespace lines.
    const time = clock();
    const stream = createLineStreamRedactor(createRedactor("secrets"), {
      timeBound: time.timeBound,
      maxHeldLines: 2,
    });
    expect(stream.push("Authorization: Bearer")).toEqual([]);
    time.advance(500);
    expect(stream.expire()).toEqual(["Authorization: Bearer"]);
    expect(stream.push("")).toEqual([]);
    expect(stream.push("  ")).toEqual([]);
    // Then the bound ends suppression and the next line flows again, even though
    // it could have carried the token.
    expect(stream.push("   ")).toEqual(["   "]);
    expect(stream.push("   abc123")).toEqual(["   abc123"]);
  });

  test("a truncated line during a Bearer continuation keeps suppressing until the bound", () => {
    // Given a released introducer and a truncated line, which lost synchronization.
    const time = clock();
    const stream = createLineStreamRedactor(createRedactor("secrets"), {
      timeBound: time.timeBound,
      maxHeldLines: 2,
    });
    expect(stream.push("Authorization: Bearer")).toEqual([]);
    time.advance(500);
    expect(stream.expire()).toEqual(["Authorization: Bearer"]);
    expect(stream.push("eye", { truncated: true })).toEqual([]);
    // When the token arrives, it cannot be trusted, so it stays suppressed.
    expect(stream.push("   eyJhbGciOi.abc-123")).toEqual([]);
    // Then the bound ends suppression and later lines flow again.
    expect(stream.push("   more")).toEqual(["   more"]);
  });

  test("redactLineSequence carries a released Bearer introducer into the token line", () => {
    // Given an introducer released at the line bound with a blank line after it.
    const result = redactLineSequence(
      { redactor: createRedactor("secrets"), payloadValues: () => [] },
      ["Authorization: Bearer", "", "   eyJhbGciOi.abc-123 rest"],
      { maxHeldLines: 1 },
    );
    // Then the token line keeps its position and only the token is masked.
    expect(result).toEqual(["Authorization: Bearer", "", "[redacted] rest"]);
  });

  test("build output masks a Bearer token released by the line bound", () => {
    // Given raw process bytes whose introducer is released before its token.
    const output = createOutputLineRedactor(
      { redactor: createRedactor("secrets"), payloadValues: () => [] },
      { maxHeldLines: 1 },
    );
    const lines = [
      ...output.write(encoder.encode("Authorization: Bearer\n\n   eyJhbGciOi.abc-123 rest\n")),
      ...output.end(),
    ];
    // Then the released introducer and blank line keep their positions.
    expect(lines).toEqual(["Authorization: Bearer", "", "[redacted] rest"]);
  });
});

describe("line continuation: a cut piece that opens a value", () => {
  test("a real line boundary consumes the trailing backslash, so the next quote closes", () => {
    // Given a released value whose continuation ends a line with a backslash.
    const time = clock();
    const stream = createLineStreamRedactor(createRedactor("secrets"), { timeBound: time.timeBound });
    expect(stream.push('password="first')).toEqual([]);
    time.advance(500);
    expect(stream.expire()).toEqual(["password=[redacted]"]);
    expect(stream.push("tail\\")).toEqual([]);
    // When the next line starts with a quote: the backslash escaped the newline
    // itself, so this quote is the closer and the rest of the line resumes.
    expect(stream.push('" public')).toEqual([" public"]);
    expect(stream.push("later")).toEqual(["later"]);
  });

  test("a fragment boundary keeps the backslash parity across the cut", () => {
    // Given a released value and a cut piece that ends exactly with a backslash.
    const time = clock();
    const channel = createLiveChannel({
      kind: "bytes",
      redactor: createRedactor("secrets"),
      payloadValues: () => [],
      timeBound: time.timeBound,
      maxPieceBytes: 12,
    });
    channel.feed(encoder.encode('password="a\n'));
    time.advance(500);
    channel.expire();
    expect(drain(channel)).toEqual(["password=[redacted]\n"]);
    channel.feed(encoder.encode("xxxxxxxxxxx\\"));
    expect(drain(channel)).toEqual([]);
    // When the next piece starts with a quote, the contiguous backslash escapes
    // it: it is not the closer, so the value stays suppressed.
    channel.feed(encoder.encode('" public\n'));
    expect(drain(channel)).toEqual([]);
    // Then a later real closer ends the value and only its tail survives.
    channel.feed(encoder.encode('x" tail\n'));
    expect(drain(channel)).toEqual([" tail\n"]);
    channel.end();
  });

  test("a cut piece that itself opens a quoted value keeps the continuation suppressed", () => {
    // Given one line longer than the piece cap whose assignment opens a quote at
    // the cut, so the opener and its value are split across pieces.
    const channel = createLiveChannel({
      kind: "bytes",
      redactor: createRedactor("secrets"),
      payloadValues: () => [],
      maxPieceBytes: 16,
    });
    channel.feed(encoder.encode('password="abcdefghijklmnopqrstuvwxyz'));
    // When the rest of the line (closer, suffix and later lines) arrives.
    channel.feed(encoder.encode('" tail\npublic\n'));
    channel.end();
    // Then no value byte survives and only the post-closer remainder is kept.
    const output = drain(channel).join("");
    expect(output).toBe("password=[redacted] tail\npublic\n");
    for (const value of ["abcdef", "ghijklmnopqrst", "wxyz"]) expect(output).not.toContain(value);
  });

  test("a cut piece that itself opens a Bearer introducer masks the token that follows", () => {
    // Given a piece cut exactly after the introducer, with no value layer hold.
    const channel = createLiveChannel({
      kind: "bytes",
      redactor: createRedactor("secrets"),
      payloadValues: () => [],
      maxPieceBytes: 21,
    });
    channel.feed(encoder.encode("Authorization: Bearer eyJhbGciOi.abc-123 rest"));
    channel.feed(encoder.encode("\npublic\n"));
    channel.end();
    // Then the token is masked and the rest of its line is kept.
    const output = drain(channel).join("");
    expect(output).toBe("Authorization: Bearer[redacted] rest\npublic\n");
    expect(output).not.toContain("eyJhbGciOi");
  });
});
