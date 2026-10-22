import { expect, test } from "bun:test";
import { REDACTED, createPayloadRedactor, createSecretRedactor } from "@lando/sdk/secrets";
import { LOG_LINE_TRUNCATED_MARKER } from "../../src/log-follow/marker.ts";

type Interval = { readonly start: number; readonly end: number };
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function random(seed: number): (limit: number) => number {
  let state = seed;
  return (limit) => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) % limit;
  };
}

function word(next: (limit: number) => number, alphabet: readonly string[], length: number): string {
  return Array.from({ length }, () => alphabet[next(alphabet.length)]).join("");
}

function occurrences(text: string, values: readonly string[]): Interval[] {
  return values.flatMap((value) => {
    const hits: Interval[] = [];
    for (let start = text.indexOf(value); start !== -1; start = text.indexOf(value, start + 1)) {
      hits.push({ start, end: start + value.length });
    }
    return hits;
  });
}

function union(intervals: readonly Interval[]): Interval[] {
  const merged: Interval[] = [];
  for (const interval of [...intervals].sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1);
    if (last !== undefined && interval.start < last.end) {
      merged[merged.length - 1] = { start: last.start, end: Math.max(last.end, interval.end) };
    } else merged.push(interval);
  }
  return merged;
}

function mask(text: string, intervals: readonly Interval[]): string {
  let cursor = 0;
  let output = "";
  for (const { start, end } of union(intervals)) {
    output += text.slice(cursor, start) + REDACTED;
    cursor = end;
  }
  return output + text.slice(cursor);
}

function referencePass(text: string, values: readonly string[]): string {
  const sentinels = occurrences(text, [REDACTED]);
  const intervals = occurrences(text, values).flatMap((hit) => {
    if (sentinels.some((sentinel) => hit.start >= sentinel.start && hit.end <= sentinel.end)) return [];
    let start = hit.start;
    let end = hit.end;
    for (const sentinel of sentinels) {
      if (hit.start < sentinel.end && hit.end > sentinel.start) {
        start = Math.min(start, sentinel.start);
        end = Math.max(end, sentinel.end);
      }
    }
    return [{ start, end }];
  });
  return mask(text, intervals);
}

function reference(text: string, values: readonly string[]): string {
  let output = text;
  for (let pass = 0; pass < 8; pass += 1) {
    const next = referencePass(output, values);
    if (next === output) return output;
    output = next;
  }
  return REDACTED;
}

function stream(text: string, values: readonly string[], sizes: readonly number[]): Uint8Array<ArrayBuffer> {
  const redactor = createPayloadRedactor(() => values);
  const input = encoder.encode(text);
  const output: number[] = [];
  let start = 0;
  for (const size of sizes) {
    output.push(...redactor.write(input.subarray(start, start + size)));
    start += size;
  }
  output.push(...redactor.write(input.subarray(start)), ...redactor.flush());
  return Uint8Array.from(output);
}

const cases = (seed: number, alphabet: readonly string[]) => {
  const next = random(seed);
  return Array.from({ length: 600 }, () => {
    const values = Array.from({ length: 1 + next(6) }, () => word(next, alphabet, 1 + next(7)));
    const text =
      word(next, alphabet, next(25)) + values[next(values.length)] + word(next, alphabet, next(25));
    return { text, values, sizes: Array.from({ length: 20 }, () => next(7)) };
  });
};

test("string masking agrees with the occurrence-union oracle without sentinel-crossing values", () => {
  // Given
  const inputs = cases(0x1a2b3c, ["a", "b", "x", "-"]);
  for (const { text, values } of inputs) {
    // When
    const output = createSecretRedactor(values).redact(text);
    // Then
    expect(output).toBe(mask(text, occurrences(text, values)));
  }
});

test("string masking agrees with the fixed-point oracle and is idempotent with sentinel collisions", () => {
  // Given
  const inputs = cases(0x5eed, ["a", "b", "[", "]", "x", "-", REDACTED]);
  for (const { text, values } of inputs) {
    const redactor = createSecretRedactor([...values, "x[", "]b"]);
    // When
    const output = redactor.redact(text);
    // Then
    expect(output).toBe(reference(text, [...values, "x[", "]b"]));
    expect(redactor.redact(output)).toBe(output);
  }
});

test("payload unions agree with the reference for random and one-byte UTF-8 chunk splits", () => {
  // Given
  const inputs = cases(0xc0ffee, ["a", "b", "[", "]", "x", "-", "€", "秘", "😀"]);
  for (const { text, values, sizes } of inputs) {
    const expected = encoder.encode(mask(text, occurrences(text, values)));
    // When
    const randomChunks = stream(text, values, sizes);
    const byteChunks = stream(
      text,
      values,
      Array.from({ length: encoder.encode(text).length }, () => 1),
    );
    // Then
    expect(randomChunks).toEqual(expected);
    expect(byteChunks).toEqual(expected);
  }
});

test("string and decoded payload layers agree on well-formed text without sentinel crossings", () => {
  // Given
  const inputs = cases(0xabcdef, ["a", "b", "x", "-", "é", "€", "😀"]);
  for (const { text, values, sizes } of inputs) {
    // When
    const stringOutput = createSecretRedactor(values).redact(text);
    const payloadOutput = decoder.decode(stream(text, values, sizes));
    // Then
    expect(stringOutput).toBe(payloadOutput);
  }
});

test("every byte in every original occurrence is covered, including overlap tails", () => {
  // Given
  const inputs = cases(0xface, ["a", "b", "x", "-", "€", "😀"]);
  for (const { text, values, sizes } of inputs) {
    const hits = occurrences(text, values);
    const intervals = union(hits);
    const input = encoder.encode(text);
    // When
    const output = stream(text, values, sizes);
    const visible = new Set<number>();
    let source = 0;
    let target = 0;
    for (const interval of intervals) {
      const start = encoder.encode(text.slice(0, interval.start)).length;
      const end = encoder.encode(text.slice(0, interval.end)).length;
      while (source < start) {
        expect(output[target++]).toBe(input[source]);
        visible.add(source++);
      }
      expect(output.subarray(target, target + REDACTED.length)).toEqual(encoder.encode(REDACTED));
      target += REDACTED.length;
      source = end;
    }
    while (source < input.length) {
      expect(output[target++]).toBe(input[source]);
      visible.add(source++);
    }
    // Then
    expect(target).toBe(output.length);
    expect(encoder.encode(createSecretRedactor(values).redact(text))).toEqual(output);
    for (const hit of hits) {
      const start = encoder.encode(text.slice(0, hit.start)).length;
      const end = encoder.encode(text.slice(0, hit.end)).length;
      for (let byte = start; byte < end; byte += 1) expect(visible.has(byte)).toBe(false);
    }
  }
});

test("bounded masking equals unbounded output exactly when its UTF-8 bytes fit", () => {
  // Given
  const inputs = cases(0xb0d, ["a", "b", "x", "-", "é", "€", "😀"]);
  for (const { text, values } of inputs) {
    const redactor = createSecretRedactor(values);
    const expected = reference(text, values);
    const bytes = encoder.encode(expected).length;
    // When
    const exact = redactor.redactBounded?.(text, bytes);
    const short = redactor.redactBounded?.(text, bytes - 1);
    // Then
    expect(exact).toBe(redactor.redact(text));
    expect(exact).toBe(expected);
    expect(short).toBeUndefined();
  }
});

test("bounded sentinel-crossing masking applies the budget to every oracle pass", () => {
  // Given
  const inputs = cases(0x123456, ["a", "b", "[", "]", "x", "-", REDACTED, "€"]);
  const next = random(0x654321);
  for (const { text, values } of inputs) {
    const crossing = [...values, "x[", "]b"];
    const budget = next(150);
    let expected: string | undefined = text;
    for (let pass = 0; pass < 8; pass += 1) {
      const result = referencePass(expected, crossing);
      if (encoder.encode(result).length > budget) {
        expected = undefined;
        break;
      }
      if (result === expected) break;
      expected = pass === 7 ? REDACTED : result;
    }
    // When
    const output = createSecretRedactor(crossing).redactBounded?.(text, budget);
    // Then
    expect(output).toBe(expected);
  }
});

test("sentinel-widening reaches a fixed point when replacement creates a crossing value", () => {
  // Given
  const redactor = createSecretRedactor(["ab", "x["]);
  // When
  const output = redactor.redact("xab");
  // Then
  expect(output).toBe(REDACTED);
  expect(redactor.redact(output)).toBe(output);
  expect(redactor.redactBounded?.("xab", 11)).toBe(REDACTED);
  expect(redactor.redactBounded?.("xab", 10)).toBeUndefined();
});

test("unions mask crossing occurrences and truncation prefixes but keep adjacent intervals separate", () => {
  // Given
  const redactor = createSecretRedactor(["abc", "bcdef", "defghi"]);
  const input = `abcdef${LOG_LINE_TRUNCATED_MARKER}`;
  // When
  const output = redactor.redact(input);
  // Then
  expect(output).toBe(`${REDACTED}${LOG_LINE_TRUNCATED_MARKER}`);
  expect(redactor.redactBounded?.(input, 100)).toBe(output);
  expect(createSecretRedactor(["abc", "bcdef"]).redact("abcdef")).toBe(REDACTED);
  expect(createSecretRedactor(["a", "b"]).redact("ab")).toBe(REDACTED.repeat(2));
  expect(decoder.decode(stream("ab", ["a", "b"], [1, 1]))).toBe(REDACTED.repeat(2));
});
