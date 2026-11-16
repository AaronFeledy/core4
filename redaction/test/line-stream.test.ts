import { describe, expect, test } from "bun:test";
import {
  createLineStreamRedactor,
  createOutputLineRedactor,
  redactLineSequence,
  redactLineText,
} from "@lando/redaction/line-stream";
import { createRedactor } from "@lando/sdk/secrets";

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
    expect(stream.push("later line")).toEqual(["later line"]);
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

  test("masks a held region when its framer dropped bytes", () => {
    // Given
    const result = pushLines(['password="first', "tail after truncation"], { truncated: [0] });

    // Then
    expect(result.lines).toEqual(["password=[redacted]", "tail after truncation"]);
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
      expect(stream.push("public")).toEqual(["public"]);
    },
  );

  test("releases a held construct immediately when a quote-free continuation was truncated", () => {
    // Given an open quote held before the truncated frame arrives.
    const stream = createLineStreamRedactor(createRedactor("secrets"));
    expect(stream.push('password="first')).toEqual([]);
    // When
    const released = stream.push("canary", { truncated: true });
    // Then truncation bypasses the quote-skip hold and clears it for subsequent output.
    expect(released).toEqual(["password=[redacted]"]);
    expect(stream.push("public")).toEqual(["public"]);
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
