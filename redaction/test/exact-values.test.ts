import { expect, test } from "bun:test";
import { REDACTED, createPayloadRedactor } from "@lando/sdk/secrets";
import { expandRedactionValues } from "../src/exact-values.ts";
import { createOutputLineRedactor } from "../src/line-stream.ts";
import { createPayloadValues, createStandaloneRedactor } from "../src/service.ts";

test.each([
  ["\ud800private", "\\ud800private"],
  ["\udc00private", "\\udc00private"],
])("masks raw and JSON forms when %j contains a lone surrogate", (secret, escaped) => {
  // Given
  const options = { redactionTokens: [secret] };
  const text = `<>${secret}<>${escaped}<>`;
  const expected = `<>${REDACTED}<>${REDACTED}<>`;

  // When
  const strings = createStandaloneRedactor("secrets", options);
  const payload = createPayloadRedactor(createPayloadValues([], options));
  const stringOutput = strings.redactString(text);
  const payloadOutput = Buffer.concat([
    payload.write(new TextEncoder().encode(text)),
    payload.flush(),
  ]).toString();

  // Then
  expect(stringOutput).toBe(expected);
  expect(payloadOutput).toBe(expected);
});

test("derives a CRLF variant of an LF value and an LF variant of a CRLF value", () => {
  // Given a value registered with each line ending.
  const lf = expandRedactionValues(["left\nright"]);
  const crlf = expandRedactionValues(["left\r\nright"]);

  // Then both spellings are matchable from either registration.
  expect(lf).toContain("left\nright");
  expect(lf).toContain("left\r\nright");
  expect(crlf).toContain("left\r\nright");
  expect(crlf).toContain("left\nright");
});

test("applies every encoding to each line-ending variant", () => {
  // Given an LF value that will be printed with CRLF.
  const values = expandRedactionValues(["left\nright"]);

  // Then the JSON-escaped and URI-encoded forms of the CRLF spelling are present too.
  expect(values).toContain(JSON.stringify("left\r\nright").slice(1, -1));
  expect(values).toContain(encodeURIComponent("left\r\nright"));
  expect(values).toContain(Buffer.from("left\r\nright", "utf8").toString("base64"));
});

test("whole-token values inherit line-ending variants", () => {
  const values = expandRedactionValues(["left\nright"], "whole-token");

  expect(values).toContain("left\r\nright");
});

test("a single-line value gains no line-ending variant", () => {
  const values = expandRedactionValues(["plain-token"]);

  expect(values.filter((value) => value.includes("\n") || value.includes("\r"))).toEqual([]);
});

test("a CRLF-registered multi-line value masks LF output end to end", () => {
  // Given a value registered with CRLF and a stream that prints LF.
  const values = ["left\r\nright"];
  const output = createOutputLineRedactor({
    redactor: createStandaloneRedactor("secrets"),
    payloadValues: createPayloadValues(values),
  });
  const encoder = new TextEncoder();

  // When
  const lines = [...output.write(encoder.encode("before left\nright after\n")), ...output.end()];

  // Then neither half survives.
  expect(lines).toEqual(["before [redacted] after"]);
});
