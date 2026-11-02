import { describe, expect, test } from "bun:test";
import { REDACTED, createPayloadRedactor } from "@lando/sdk/secrets";

const encoder = new TextEncoder();
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe("payload byte redaction", () => {
  test("masks a secret amid invalid bytes at every split position", () => {
    // Given
    const values = ["hunter22"];
    const input = new Uint8Array([255, ...encoder.encode("hunter22"), 0, 128]);
    const expected = new Uint8Array([255, ...encoder.encode(REDACTED), 0, 128]);
    for (let split = 0; split <= input.length; split += 1) {
      const redactor = createPayloadRedactor(() => values);
      // When
      const chunks = [
        redactor.write(input.subarray(0, split)),
        redactor.write(new Uint8Array(0)),
        redactor.write(input.subarray(split)),
        redactor.flush(),
      ];
      // Then
      expect(new Uint8Array(chunks.flatMap((chunk) => [...chunk]))).toEqual(expected);
    }
  });
  test("emits safe bytes immediately and holds only a proper secret prefix", () => {
    // Given
    const values = ["hunter22"];
    const redactor = createPayloadRedactor(() => values);
    // When
    const first = redactor.write(encoder.encode("safe hun"));
    const second = redactor.write(encoder.encode("ter22 tail"));
    // Then
    expect(decode(first)).toBe("safe ");
    expect(decode(second)).toBe(`${REDACTED} tail`);
  });

  test("chooses the longest nested match across a chunk boundary", () => {
    // Given
    const values = ["abc", "abcdef", "bcd"];
    const redactor = createPayloadRedactor(() => values);
    // When
    const first = redactor.write(encoder.encode("abc"));
    const second = redactor.write(encoder.encode("def!"));
    // Then
    expect(first.length).toBe(0);
    expect(decode(second)).toBe(`${REDACTED}!`);
  });

  test("handles overlapping matches without masking replacement bytes", () => {
    // Given
    const values = ["aba", "bab", "redacted"];
    const redactor = createPayloadRedactor(() => values);
    // When
    const output = redactor.write(encoder.encode("ababa!"));
    // Then
    expect(decode(output)).toBe(`${REDACTED}!`);
  });

  test("matches UTF-8 secrets split in the middle of a codepoint", () => {
    // Given
    const values = ["€秘密"];
    const bytes = encoder.encode(values[0]);
    const redactor = createPayloadRedactor(() => values);
    // When
    const first = redactor.write(bytes.subarray(0, 2));
    const second = redactor.write(bytes.subarray(2));
    // Then
    expect(first.length).toBe(0);
    expect(decode(second)).toBe(REDACTED);
  });

  test("flushes incomplete matches and completes shorter matches at EOF", () => {
    // Given
    const values = ["abcdef", "abc"];
    const incomplete = createPayloadRedactor(() => values);
    const complete = createPayloadRedactor(() => values);
    incomplete.write(encoder.encode("ab"));
    complete.write(encoder.encode("abc"));
    // When
    const tail = incomplete.flush();
    const masked = complete.flush();
    // Then
    expect(decode(tail)).toBe("ab");
    expect(decode(masked)).toBe(REDACTED);
    expect(complete.flush().length).toBe(0);
  });

  test("refreshes values registered mid-stream including the held tail", () => {
    // Given
    let values = ["hunter22"];
    const redactor = createPayloadRedactor(() => values);
    redactor.write(encoder.encode("hun"));
    values = ["hunter22", "hunted", "new-secret"];
    // When
    const output = redactor.write(encoder.encode("ted new-secret!"));
    // Then
    expect(decode(output)).toBe(`${REDACTED} ${REDACTED}!`);
  });

  test("preserves arbitrary bytes and empty chunks without pattern rewriting", () => {
    // Given
    const values: string[] = [];
    const redactor = createPayloadRedactor(() => values);
    const input = new Uint8Array([...encoder.encode("PASSWORD=public\n"), 255, 0, 128]);
    // When
    const empty = redactor.write(new Uint8Array(0));
    const output = redactor.write(input);
    // Then
    expect(empty.length).toBe(0);
    expect(output).toEqual(input);
  });

  test("passes chunks through untouched with no registered secrets", () => {
    // Given
    const redactor = createPayloadRedactor(() => []);
    const input = Uint8Array.of(0xff, 0x00, 0x80, 0x0a);

    // When
    const output = redactor.write(input);

    // Then
    expect(output).toEqual(input);
    expect(redactor.flush().length).toBe(0);
  });
});
