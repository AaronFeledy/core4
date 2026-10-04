import { describe, expect, spyOn, test } from "bun:test";
import { Effect } from "effect";
import {
  encodeEngineFilters,
  parseJsonOrUndefined,
  parseNdjsonLines,
  tryParseJson,
} from "../src/engine-json.ts";

describe("engine JSON", () => {
  test.each([
    ["not json", undefined],
    ["{}", {}],
    ["null", null],
    ["", undefined],
  ])("returns the parsed value or undefined when given %s", (text, expected) => {
    // Given / When
    const result = parseJsonOrUndefined(String(text));
    // Then
    expect(result).toEqual(expected);
  });

  test("maps malformed JSON to the caller error when the effect runs", () => {
    // Given
    const onError = (cause: unknown) => ({ _tag: "ParseFailure", cause });
    const effect = tryParseJson("not json", onError);
    // When
    const error = Effect.runSync(effect.pipe(Effect.flip));
    // Then
    expect(error._tag).toBe("ParseFailure");
    expect(error.cause).toBeInstanceOf(SyntaxError);
  });

  test("returns JSON without invoking the error mapper when parsing succeeds", () => {
    // Given
    const effect = tryParseJson('{"x":1}', () => "unexpected failure");
    // When
    const result = Effect.runSync(effect);
    // Then
    expect(result).toEqual({ x: 1 });
  });

  test.each(["skip", "rethrow-non-syntax"] as const)(
    "skips blank and malformed lines when policy is %s",
    (onInvalidLine) => {
      // Given
      const body = 'a\n\n  \n{"x":1}\r\n';
      // When
      const result = Array.from(parseNdjsonLines(body, { separator: /\r?\n/u, onInvalidLine }));
      // Then
      expect(result).toEqual([{ x: 1 }]);
    },
  );

  test("preserves JSON scalars and order when splitting on newlines", () => {
    // Given
    const body = 'null\nfalse\n0\n"value"\n';
    // When
    const result = Array.from(parseNdjsonLines(body, { separator: "\n", onInvalidLine: "skip" }));
    // Then
    expect(result).toEqual([null, false, 0, "value"]);
  });

  test("yields frames lazily so early consumers never parse later lines", () => {
    // Given: first frame is valid JSON; later lines must not be parsed if the consumer stops.
    const nativeParse = JSON.parse.bind(JSON);
    let parseCount = 0;
    const parser = spyOn(JSON, "parse").mockImplementation((text: string) => {
      parseCount += 1;
      return nativeParse(text);
    });
    try {
      const body = '{"error":"boom"}\n{"errorDetail":{"message":"later"}}\nnot-json';
      // When
      const iterator = parseNdjsonLines(body, { separator: "\n", onInvalidLine: "rethrow-non-syntax" });
      // Then: structural laziness — return value is an iterator/generator
      expect(typeof iterator.next).toBe("function");
      expect(Symbol.iterator in iterator).toBe(true);

      // buildStreamError-style consumption: take first matching frame and stop
      let firstError: string | undefined;
      for (const parsed of iterator) {
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          typeof (parsed as { error?: unknown }).error === "string"
        ) {
          firstError = (parsed as { error: string }).error;
          break;
        }
      }
      expect(firstError).toBe("boom");
      // Only the first line was parsed; later frames were never advanced
      expect(parseCount).toBe(1);
    } finally {
      parser.mockRestore();
    }
  });

  test("rethrows the original non-syntax failure when the policy requires it", () => {
    // Given: native JSON.parse only throws SyntaxError for strings; simulate a runtime failure.
    const cause = new TypeError("parser unavailable");
    const parser = spyOn(JSON, "parse").mockImplementation(() => {
      throw cause;
    });
    try {
      // When / Then
      expect(() =>
        Array.from(parseNdjsonLines("{}", { separator: "\n", onInvalidLine: "rethrow-non-syntax" })),
      ).toThrow(cause);
    } finally {
      parser.mockRestore();
    }
  });

  test("skips non-syntax failures when the policy is skip", () => {
    // Given
    const parser = spyOn(JSON, "parse").mockImplementation(() => {
      throw new TypeError("parser unavailable");
    });
    try {
      // When
      const result = Array.from(parseNdjsonLines("{}", { separator: "\n", onInvalidLine: "skip" }));
      // Then
      expect(result).toEqual([]);
    } finally {
      parser.mockRestore();
    }
  });

  test("encodes filter values in insertion order when multiple keys are supplied", () => {
    // Given
    const filters = { label: ["a=b"], name: ["x"] };
    // When
    const encoded = encodeEngineFilters(filters);
    // Then
    expect(encoded).toBe("%7B%22label%22%3A%5B%22a%3Db%22%5D%2C%22name%22%3A%5B%22x%22%5D%7D");
  });
});
