import { describe, expect, test } from "bun:test";
import {
  createLineStreamRedactor,
  createOutputLineRedactor,
  redactLineSequence,
  redactLineText,
} from "@lando/redaction/line-stream";
import { createRedactor } from "@lando/sdk/secrets";

import { createPayloadValues } from "../src/service.ts";

const encoder = new TextEncoder();

interface StreamResult {
  readonly lines: readonly string[];
  readonly text: string;
}

const runPipeline = (
  input: string,
  chunkSize: number | readonly number[],
  options: {
    readonly values?: ReadonlyArray<string>;
    readonly maxHeldLines?: number;
    readonly maxHeldBytes?: number;
  } = {},
): StreamResult => {
  const values = options.values ?? [];
  const output = createOutputLineRedactor(
    { redactor: createRedactor("secrets", { values }), payloadValues: () => values },
    {
      ...(options.maxHeldLines === undefined ? {} : { maxHeldLines: options.maxHeldLines }),
      ...(options.maxHeldBytes === undefined ? {} : { maxHeldBytes: options.maxHeldBytes }),
    },
  );
  const bytes = encoder.encode(input);
  const lines: string[] = [];
  const sizes = typeof chunkSize === "number" ? undefined : chunkSize;
  const scalarSize = typeof chunkSize === "number" ? chunkSize : 1;
  let offset = 0;
  let index = 0;
  while (offset < bytes.length) {
    const size = sizes === undefined ? scalarSize : (sizes[index % sizes.length] ?? 1);
    const next = Math.min(offset + size, bytes.length);
    lines.push(...output.write(bytes.subarray(offset, next)));
    offset = next;
    index += 1;
  }
  lines.push(...output.end());
  return { lines, text: lines.join("\n") };
};

const pushLines = (
  inputLines: ReadonlyArray<string>,
  options: {
    readonly maxHeldLines?: number;
    readonly maxHeldBytes?: number;
    readonly truncated?: ReadonlyArray<number>;
  } = {},
): StreamResult => {
  const redactor = createRedactor("secrets");
  const lineStream = createLineStreamRedactor(redactor, {
    ...(options.maxHeldLines === undefined ? {} : { maxHeldLines: options.maxHeldLines }),
    ...(options.maxHeldBytes === undefined ? {} : { maxHeldBytes: options.maxHeldBytes }),
  });
  const lines: string[] = [];
  for (const [index, line] of inputLines.entries()) {
    lines.push(
      ...lineStream.push(line, {
        truncated: options.truncated?.includes(index) === true,
      }),
    );
  }
  lines.push(...lineStream.flush());
  return { lines, text: lines.join("\n") };
};

describe("createLineStreamRedactor", () => {
  test("masks a quoted assignment value that spans lines", () => {
    // Given the issue shape: a quoted password split over three frames.
    const input = 'password="first\ncanary-multiline-secret\nlast"\n';

    // When
    const result = runPipeline(input, 1);

    // Then
    expect(result.text).toBe("password=[redacted]");
    expect(result.text).not.toContain("canary-multiline-secret");
  });

  test("masks a bearer token whose whitespace spans lines", () => {
    // Given
    const input = "Authorization: Bearer\ncanary-bearer-token\n";

    // When
    const result = runPipeline(input, 1);

    // Then
    expect(result.text).toBe("Authorization: Bearer [redacted]");
    expect(result.text).not.toContain("canary-bearer-token");
  });

  test("produces the same lines at every byte boundary", () => {
    // Given a quoted value, CRLF terminators, UTF-8 text, and blank lines.
    const input =
      'logger: caf\u00e9\r\npassword="first\r\n\r\ncanary-multiline-secret\r\n\r\nlast"\r\nnext line\r\n';

    // When
    const whole = runPipeline(input, input.length);
    const boundaries = [1, 2, 3, 5, 7, 13].map((size) => runPipeline(input, size));

    // Then
    expect(whole.text).toBe("logger: caf\u00e9\npassword=[redacted]\nnext line");
    for (const result of boundaries) expect(result.text).toBe(whole.text);
    for (const result of boundaries) expect(result.text).not.toContain("canary-multiline-secret");
  });

  test("keeps a registered multi-line value masked across chunk boundaries", () => {
    // Given a value the payload layer matches across a newline.
    const values = ["first\nstill-secret"];
    const input = "before first\nstill-secret after\n";

    // When
    const result = runPipeline(input, 1, { values });

    // Then
    expect(result.text).toBe("before [redacted] after");
  });

  test("treats a URL userinfo quote as the real assignment opener", () => {
    // Given userinfo consumes `pass"@` before the assignment stage runs.
    const input = 'password="https://u:pass"@host\ncanary\nlast"\n';

    // When
    const result = runPipeline(input, 1);

    // Then
    expect(result.text).toBe("password=[redacted]");
    expect(result.text).not.toContain("canary");
  });

  test("does not hold a shell string whose closing quote follows the name", () => {
    // Given an assignment-shaped name inside a closed shell string.
    const input = `RUN echo "token=" > f\npublic line\nnext "quote"\n`;

    // When
    const result = runPipeline(input, 1);

    // Then
    expect(result.lines).toEqual(['RUN echo "token=" > f', "public line", 'next "quote"']);
    expect(result.text).toContain("public line");
  });

  test("does not hold a masked value that a closing shell quote follows", () => {
    // Given a build instruction whose secret value ends a double-quoted shell string.
    const input = `STEP 3/5: RUN sh -c "mysql --password=secret"\nSTEP 4/5: RUN make\nbuilt ok\n`;

    // When
    const result = runPipeline(input, 1);

    // Then
    expect(result.lines).toEqual([
      'STEP 3/5: RUN sh -c "mysql --password=[redacted]"',
      "STEP 4/5: RUN make",
      "built ok",
    ]);
  });

  test("masks only the held region when a line bound is exceeded", () => {
    // Given an unterminated opener that outlives its hold bound.
    const stream = createLineStreamRedactor(createRedactor("secrets"), { maxHeldLines: 2 });

    // When / Then no quote-free continuation escapes, and overflow releases before flush.
    expect(stream.push('password="first')).toEqual([]);
    expect(stream.push("canary-held")).toEqual([]);
    expect(stream.push("one too many")).toEqual(["password=[redacted]"]);
    // The released value's continuation stays suppressed, never exposed.
    expect(stream.push("later line")).toEqual([]);
    expect(stream.push('closer" tail')).toEqual([" tail"]);
    expect(stream.flush()).toEqual([]);
  });

  test("masks a single oversized line immediately instead of retaining it", () => {
    // Given one line larger than the whole byte bound.
    const stream = createLineStreamRedactor(createRedactor("secrets"), { maxHeldBytes: 8 });

    // When / Then the push releases without waiting for end of stream.
    expect(stream.push(`password="${"x".repeat(64)}`)).toEqual(["password=[redacted]"]);
    expect(stream.flush()).toEqual([]);
  });

  test("masks an unterminated construct at end of stream", () => {
    // Given
    const result = pushLines(['password="never-closed']);

    // Then
    expect(result.lines).toEqual(["password=[redacted]"]);
  });

  test("masks the continuation of a region whose framer dropped bytes", () => {
    // Given a truncated frame in the middle of a quoted value: the framer may
    // have dropped the closer, so nothing after it can be trusted.
    const result = pushLines(['password="first', "tail after truncation"], { truncated: [0] });

    // Then the whole value is masked and its continuation is not exposed.
    expect(result.lines).toEqual(["password=[redacted]"]);
  });

  test("is idempotent over its own released lines", () => {
    // Given
    const first = runPipeline('a password="first\ncanary\nlast" b\n', 1);
    const redactor = createRedactor("secrets");
    const second = createLineStreamRedactor(redactor);
    const again = first.lines.flatMap((line) => second.push(line));
    again.push(...second.flush());

    // Then
    expect(again.join("\n")).toBe(first.text);
    for (const line of first.lines) expect(redactor.redactString(line)).toBe(line);
  });

  test("matches whole-string redaction when constructs fit the bounds", () => {
    // Given inputs whose constructs complete within the default hold and contain no excluded opener.
    const inputs = [
      'password="first\ncanary\nlast"',
      "Authorization: Bearer\ncanary-bearer",
      '?token="first\ncanary\nlast"',
      "password='single\ncanary\nquoted'",
      'client_secret="https://user:pass"@host\ncanary\nlast"',
      "first line\npassword=plain-value\nlast line",
    ];
    const redactor = createRedactor("secrets");

    // When / Then
    for (const input of inputs) {
      const result = pushLines(input.split("\n"));
      expect(result.text).toBe(redactor.redactString(input));
      expect(result.text).not.toContain("canary");
    }
  });

  test.each([
    ["64 lines", ['password="', ...Array.from({ length: 63 }, () => "x")]],
    ["16384 UTF-8 bytes", ['password="', `${"\u00e9".repeat(8186)}x`]],
  ] as const)(
    "releases a held construct immediately after the default %s bound",
    (_: string, lines: readonly string[]) => {
      // Given a block exactly at the default bound.
      const stream = createLineStreamRedactor(createRedactor("secrets"));
      // When / Then the exact bound holds, and one more quote-free line releases it.
      for (const line of lines) expect(stream.push(line)).toEqual([]);
      expect(stream.push("x")).toEqual(["password=[redacted]"]);
      // Then the released value's continuation stays suppressed, never exposed.
      expect(stream.push("public")).toEqual([]);
      expect(stream.push('still"')).toEqual([]);
      expect(stream.push("later")).toEqual(["later"]);
    },
  );

  test("releases a held construct immediately when a quote-free continuation was truncated", () => {
    // Given an open quote held before the truncated frame arrives.
    const stream = createLineStreamRedactor(createRedactor("secrets"));
    expect(stream.push('password="first')).toEqual([]);
    // When
    const released = stream.push("canary", { truncated: true });
    // Then truncation releases the block, and the lost synchronization keeps
    // suppressing the value's continuation instead of exposing it.
    expect(released).toEqual(["password=[redacted]"]);
    expect(stream.push("public")).toEqual([]);
  });
});

describe("continuation suppression", () => {
  const clock = () => {
    let current = 1_000;
    return {
      timeBound: { maxHeldMillis: 500, now: () => current },
      advance: (millis: number) => {
        current += millis;
      },
    };
  };

  test("suppresses a released quoted value's continuation until its closer, then resumes after it", () => {
    // Given a quoted value released fail-closed on the time bound.
    const time = clock();
    const stream = createLineStreamRedactor(createRedactor("secrets"), { timeBound: time.timeBound });
    expect(stream.push('password="first')).toEqual([]);
    time.advance(500);
    expect(stream.expire()).toEqual(["password=[redacted]"]);
    // When its continuation arrives without the closer.
    expect(stream.push("canary-inside-value")).toEqual([]);
    expect(stream.push("more-inside-value")).toEqual([]);
    // Then the closer line resumes after the whole value.
    expect(stream.push('last" tail')).toEqual([" tail"]);
    // And later lines flow normally.
    expect(stream.push("public")).toEqual(["public"]);
  });

  test("a mask keeps the whole value even when its continuation is 70 lines long", () => {
    // Given the default line bound and a value that opens before it.
    const stream = createLineStreamRedactor(createRedactor("secrets"));
    expect(stream.push('password="a')).toEqual([]);
    // When the bound releases the held region, every continuation line is dropped.
    const released = Array.from({ length: 70 }, (_, index) => stream.push(`continuation-${index}`)).flat();
    expect(released).toEqual(["password=[redacted]"]);
    // Then the closer line resumes after the value and exposes only its tail.
    expect(stream.push('b" tail')).toEqual([" tail"]);
    expect(stream.push("public")).toEqual(["public"]);
  });

  test("the closer line's remainder is re-scanned, so a second secret on it is masked", () => {
    // Given a released value and a closer line carrying another assignment.
    const time = clock();
    const stream = createLineStreamRedactor(createRedactor("secrets"), { timeBound: time.timeBound });
    expect(stream.push('password="first')).toEqual([]);
    time.advance(500);
    expect(stream.expire()).toEqual(["password=[redacted]"]);
    // When / Then the remainder after the whole shell word is masked normally.
    expect(stream.push('last" token=second-secret')).toEqual([" token=[redacted]"]);
  });

  test("a CRLF terminator does not become part of the value", () => {
    // Given collected lines that keep their CR from a CRLF stream.
    const result = redactLineSequence(
      { redactor: createRedactor("secrets"), payloadValues: () => [] },
      ['password="a', "inside", 'b"\r', "public"],
      { maxHeldLines: 1 },
    );
    // Then the closer line contributes nothing and later lines keep their positions.
    expect(result).toEqual(["password=[redacted]", undefined, undefined, "public"]);
  });

  test("a truncated line during suppression keeps suppressing until the bound", () => {
    // Given suppression entered by a truncated frame, which lost synchronization.
    const stream = createLineStreamRedactor(createRedactor("secrets"), { maxHeldLines: 2 });
    expect(stream.push('password="first')).toEqual([]);
    expect(stream.push("canary", { truncated: true })).toEqual(["password=[redacted]"]);
    // When a later line happens to carry a quote, it must not be trusted.
    expect(stream.push('b" rest')).toEqual([]);
    // Then the suppression bound ends it and output flows again.
    expect(stream.push("one")).toEqual([]);
    expect(stream.push("two")).toEqual(["two"]);
    expect(stream.push("three")).toEqual(["three"]);
  });

  test("a quote that never closes ends suppression at the bound and later lines flow", () => {
    // Given a stray opener released on the time bound.
    const time = clock();
    const stream = createLineStreamRedactor(createRedactor("secrets"), {
      timeBound: time.timeBound,
      maxHeldLines: 2,
    });
    expect(stream.push('password="stray')).toEqual([]);
    time.advance(500);
    expect(stream.expire()).toEqual(["password=[redacted]"]);
    // When quote-free lines arrive, the bound (not a closer) ends suppression.
    expect(stream.push("one")).toEqual([]);
    expect(stream.push("two")).toEqual([]);
    expect(stream.push("three")).toEqual(["three"]);
    expect(stream.push("four")).toEqual(["four"]);
  });

  test("end of stream ends suppression without exposing the continuation", () => {
    // Given a released value whose closer never arrived.
    const time = clock();
    const stream = createLineStreamRedactor(createRedactor("secrets"), { timeBound: time.timeBound });
    expect(stream.push('password="first')).toEqual([]);
    time.advance(500);
    expect(stream.expire()).toEqual(["password=[redacted]"]);
    expect(stream.push("inside")).toEqual([]);
    // Then flushing emits nothing more.
    expect(stream.flush()).toEqual([]);
  });

  test("redactLineSequence keeps dropped continuation lines at undefined", () => {
    // Given a sequence whose held value is released at the line bound.
    const result = redactLineSequence(
      { redactor: createRedactor("secrets"), payloadValues: () => [] },
      ['password="a', "inside", 'b" tail', "public"],
      { maxHeldLines: 1 },
    );
    // Then the masked value keeps position 0 and the closer's tail keeps its own.
    expect(result).toEqual(["password=[redacted]", undefined, " tail", "public"]);
  });
});

describe("redactLineText", () => {
  test.each([
    [
      'before caf\u00e9\nleft\nright\npassword="first\ncanary\nlast"\n\n',
      "before caf\u00e9\n[redacted]\npassword=[redacted]\n\n",
    ],
    ['before\npassword="canary', "before\npassword=[redacted]"],
  ])("redacts whole text through payload and line-stream layers: %j", (text: string, expected: string) => {
    // Given a registered value spanning lines and the canonical pattern redactor.
    const values = ["left\nright"];
    const scope = { redactor: createRedactor("secrets", { values }), payloadValues: () => values };
    // When
    const result = redactLineText(scope, text);
    // Then exact text preserves public Unicode, blank lines, and trailing newlines.
    expect(result).toBe(expected);
  });
});

describe("redactLineSequence", () => {
  test("keeps each released line at its input position and marks merged lines", () => {
    // Given a quoted value that spans three of five lines.
    const lines = ["first", 'password="one', "canary-sequence-secret", 'three"', "last"];

    // When
    const result = redactLineSequence(
      { redactor: createRedactor("secrets"), payloadValues: () => [] },
      lines,
    );

    // Then the block keeps its first position and the line after it keeps its own.
    expect(result).toEqual(["first", "password=[redacted]", undefined, undefined, "last"]);
  });

  test("masks a registered value that spans lines before the line-stream runs", () => {
    // Given a registered value written across two of four lines.
    const values = ["left\nright"];
    const lines = ["first", "before left", "right after", "last"];

    // When
    const result = redactLineSequence(
      { redactor: createRedactor("secrets", { values }), payloadValues: () => values },
      lines,
    );

    // Then neither half survives and the merged line takes the first slot.
    expect(result).toEqual(["first", "before [redacted] after", "last", undefined]);
  });

  test("fails a block still open at the end closed in place", () => {
    // Given an unterminated quoted value with one more line after it.
    const lines = ["before", 'token="canary-open-value', "after"];

    // When
    const result = redactLineSequence(
      { redactor: createRedactor("secrets"), payloadValues: () => [] },
      lines,
    );

    // Then
    expect(result).toEqual(["before", "token=[redacted]", undefined]);
  });
});

describe("assignment grammar forms across frames (#2399)", () => {
  test("masks an escaped-opener assignment split across frames", () => {
    // Given a shell-escaped opener whose closer is the next quote.
    const result = runPipeline('password=\\"left\nright\\"\n', 1);

    // Then both fragments are one value.
    expect(result.text).toBe("password=[redacted]");
    expect(result.text).not.toContain("left");
  });

  test("masks a colon-plus-quoted value split across frames", () => {
    const result = runPipeline('password: "first\ncanary-colon-value\nlast"\n', 1);

    expect(result.text).toBe('password: "[redacted]"');
    expect(result.text).not.toContain("canary-colon-value");
  });

  test("masks a member value split across frames and keeps the mapping quoting", () => {
    const result = runPipeline('{"password":"left\nright"}\n', 1);

    expect(result.text).toBe('{"password":"[redacted]"}');
  });

  test("masks an unclosed member value at end of stream with its key quoting", () => {
    const result = pushLines(['{"password":"left', "right"]);

    expect(result.lines).toEqual(['{"password":"[redacted]"']);
  });

  test("masks a YAML block key value split across frames", () => {
    const result = runPipeline('db_password: "first\ncanary-yaml-value\nlast"\n', 1);

    expect(result.text).toBe('db_password: "[redacted]"');
    expect(result.text).not.toContain("canary-yaml-value");
  });
});

describe("value layer line-ending variants (#2397)", () => {
  const pipeline = (values: readonly string[], input: string): StreamResult => {
    const output = createOutputLineRedactor({
      redactor: createRedactor("secrets"),
      payloadValues: createPayloadValues(values),
    });
    const lines = [...output.write(encoder.encode(input)), ...output.end()];
    return { lines, text: lines.join("\n") };
  };

  test("masks an LF-registered value printed with CRLF as one line", () => {
    expect(pipeline(["left\nright"], "before left\r\nright after\n").lines).toEqual([
      "before [redacted] after",
    ]);
  });

  test("masks a CRLF-registered value printed with LF as one line", () => {
    expect(pipeline(["left\r\nright"], "before left\nright after\n").lines).toEqual([
      "before [redacted] after",
    ]);
  });
});

describe("live time bound", () => {
  const liveClock = (start = 1_000) => {
    let current = start;
    return {
      timeBound: { maxHeldMillis: 500, now: () => current },
      advance: (millis: number) => {
        current += millis;
      },
    };
  };

  test("holds until the deadline, then releases fail-closed without another line", () => {
    // Given a quoted value whose closer has not arrived.
    const clock = liveClock();
    const stream = createLineStreamRedactor(createRedactor("secrets"), {
      timeBound: clock.timeBound,
    });
    // When the caller's clock is still inside the window.
    expect(stream.push('password="first')).toEqual([]);
    expect(stream.deadline()).toBe(1_500);
    clock.advance(499);
    expect(stream.expire()).toEqual([]);
    // Then the deadline releases the whole held region once.
    clock.advance(1);
    expect(stream.expire()).toEqual(["password=[redacted]"]);
    expect(stream.deadline()).toBeUndefined();
    // And the value's continuation stays suppressed until its closer arrives.
    expect(stream.push('last"')).toEqual([]);
    expect(stream.push("plain")).toEqual(["plain"]);
  });

  test("measures the hold from the push that began it, not from each line", () => {
    // Given a hold that began at t0.
    const clock = liveClock();
    const stream = createLineStreamRedactor(createRedactor("secrets"), {
      timeBound: clock.timeBound,
    });
    expect(stream.push('password="first')).toEqual([]);
    // When a quote-free continuation arrives inside the window.
    clock.advance(300);
    expect(stream.push("still-held")).toEqual([]);
    // Then the original deadline still applies.
    expect(stream.deadline()).toBe(1_500);
    clock.advance(199);
    expect(stream.expire()).toEqual([]);
    clock.advance(1);
    expect(stream.expire()).toEqual(["password=[redacted]"]);
  });

  test("a push after the deadline releases the expired block before processing its own line", () => {
    // Given an expired hold.
    const clock = liveClock();
    const stream = createLineStreamRedactor(createRedactor("secrets"), {
      timeBound: clock.timeBound,
    });
    expect(stream.push('password="first')).toEqual([]);
    clock.advance(600);
    // When the next push arrives after the deadline.
    expect(stream.push("canary")).toEqual(["password=[redacted]"]);
    // Then the released value's continuation is suppressed, not held again or exposed.
    expect(stream.deadline()).toBeUndefined();
    expect(stream.expire()).toEqual([]);
    // The whole value ends at the closer, including its shell-word suffix.
    expect(stream.push('tail" rest')).toEqual([" rest"]);
    expect(stream.push("public")).toEqual(["public"]);
  });

  test("keeps the payload layer's held newline bounded and releases its partial line", () => {
    // Given a registered value whose newline is withheld by the value layer.
    const clock = liveClock();
    const values = ["left\nright"];
    const output = createOutputLineRedactor(
      { redactor: createRedactor("secrets", { values }), payloadValues: () => values },
      { timeBound: clock.timeBound },
    );
    // When the value layer holds the prefix and framing has a partial line.
    expect(output.write(encoder.encode("before left\n"))).toEqual([]);
    expect(output.deadline()).toBe(1_500);
    clock.advance(499);
    expect(output.expire()).toEqual([]);
    clock.advance(1);
    // Then the partial line is released with the committed mask.
    expect(output.expire()).toEqual(["before [redacted]"]);
    // And the continuation only contributes its uncovered bytes.
    expect(output.write(encoder.encode("right after\n"))).toEqual([" after"]);
    expect(output.end()).toEqual([]);
  });

  test("never releases a producer's own partial line on expiry", () => {
    // Given a value-layer hold with no newline in the committed region.
    const clock = liveClock();
    const values = ["secret"];
    const output = createOutputLineRedactor(
      { redactor: createRedactor("secrets", { values }), payloadValues: () => values },
      { timeBound: clock.timeBound },
    );
    expect(output.write(encoder.encode("before sec"))).toEqual([]);
    clock.advance(500);
    // When expiry commits the prefix without a newline.
    expect(output.expire()).toEqual([]);
    // Then the producer's partial line waits for its own newline.
    expect(output.write(encoder.encode("ret\n"))).toEqual(["before [redacted]"]);
  });
});

describe("live time bound on the output pipeline", () => {
  const liveClock = (start = 1_000) => {
    let current = start;
    return {
      timeBound: { maxHeldMillis: 500, now: () => current },
      advance: (millis: number) => {
        current += millis;
      },
    };
  };

  test("a write after the deadline masks the expired prefix before flowing", () => {
    // Given a withheld prefix of a registered value and an expired deadline.
    const clock = liveClock();
    const values = ["secret"];
    const output = createOutputLineRedactor(
      { redactor: createRedactor("secrets", { values }), payloadValues: () => values },
      { timeBound: clock.timeBound },
    );
    expect(output.write(encoder.encode("before sec"))).toEqual([]);
    clock.advance(500);
    // When a divergent continuation arrives before the timer tick runs.
    expect(output.write(encoder.encode("ond unrelated\n"))).toEqual(["before [redacted]ond unrelated"]);
  });

  test("a line released by a value-layer expiry keeps the original hold start", () => {
    // Given a partial line withheld inside a registered value's newline prefix.
    const clock = liveClock();
    const values = ["left\nright"];
    const output = createOutputLineRedactor(
      { redactor: createRedactor("secrets", { values }), payloadValues: () => values },
      { timeBound: clock.timeBound },
    );
    expect(output.write(encoder.encode('password="left\n'))).toEqual([]);
    expect(output.deadline()).toBe(1_500);
    clock.advance(499);
    expect(output.expire()).toEqual([]);
    // Then at the payload deadline the still-open line fails closed in the same
    // release; it must not open a second 500 ms window from the release time.
    clock.advance(1);
    expect(output.expire()).toEqual(["password=[redacted]"]);
    expect(output.deadline()).toBeUndefined();
  });
});
