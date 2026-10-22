import { expect, test } from "bun:test";
import { REDACTED, createPayloadRedactor, createSecretRedactor } from "@lando/sdk/secrets";
import { LOG_LINE_TRUNCATED_MARKER } from "../../src/log-follow/marker.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

test("an emitted payload union retains covered raw prefixes to extend across later chunks", () => {
  // Given
  const values = ["abc", "bcdef", "efghi"];
  const redactor = createPayloadRedactor(() => values);
  // When
  const first = redactor.write(encoder.encode("abc"));
  const second = redactor.write(encoder.encode("def"));
  const third = redactor.write(encoder.encode("ghi!"));
  // Then
  expect(decoder.decode(first)).toBe(REDACTED);
  expect(second.length).toBe(0);
  expect(decoder.decode(third)).toBe("!");
  expect(redactor.flush().length).toBe(0);
});

test("registrations recheck covered held bytes without reemitting their sentinel", () => {
  // Given
  let values = ["abc", "bcdef"];
  const redactor = createPayloadRedactor(() => values);
  const first = redactor.write(encoder.encode("abc"));
  values = ["abc", "bcXYZ"];
  // When
  const second = redactor.write(encoder.encode("XYZ!"));
  // Then
  expect(decoder.decode(first)).toBe(REDACTED);
  expect(decoder.decode(second)).toBe("!");
  expect(redactor.flush().length).toBe(0);
});

test("a failed covered prefix flushes only its uncovered suffix", () => {
  // Given
  const values = ["abc", "bcdef"];
  const redactor = createPayloadRedactor(() => values);
  const first = redactor.write(encoder.encode("abcd"));
  // When
  const tail = redactor.flush();
  // Then
  expect(decoder.decode(first)).toBe(REDACTED);
  expect(decoder.decode(tail)).toBe("d");
});

test("truncation prefixes union with complete overlapping occurrences", () => {
  // Given
  const redactor = createSecretRedactor(["abc", "bcdef"]);
  const input = `abcde${LOG_LINE_TRUNCATED_MARKER}`;
  // When
  const output = redactor.redact(input);
  // Then
  expect(output).toBe(REDACTED + LOG_LINE_TRUNCATED_MARKER);
  expect(redactor.redactBounded?.(input, encoder.encode(output).length)).toBe(output);
});

test("partial intersections widen both ends without masking wholly contained values", () => {
  // Given
  const redactor = createSecretRedactor(["]x[", "red", "a"]);
  // When
  const output = redactor.redact("[redacted]x[redacted]");
  // Then
  expect(output).toBe(REDACTED);
  expect(redactor.redact(output)).toBe(output);
});

test("string occurrences use UTF-16 units even for lone surrogate values", () => {
  // Given
  const redactor = createSecretRedactor(["\ud83d", "\ude00x"]);
  // When
  const output = redactor.redact("😀x");
  // Then
  expect(output).toBe(REDACTED.repeat(2));
});

test("fixed-point iteration fails closed at the pass cap and stays idempotent", () => {
  // Given
  const redactor = createSecretRedactor(["ab", "x["]);
  const input = `${"x".repeat(20)}ab`;
  // When
  const output = redactor.redact(input);
  // Then
  expect(output).toBe(REDACTED);
  expect(redactor.redact(output)).toBe(output);
  expect(redactor.redactBounded?.(input, 100)).toBe(output);
});

test("each fixed-point pass must fit its budget even when the final output would fit", () => {
  // Given
  const redactor = createSecretRedactor(["ab", "x["]);
  // When
  const output = redactor.redactBounded?.("xab", REDACTED.length);
  // Then
  expect(output).toBeUndefined();
});
