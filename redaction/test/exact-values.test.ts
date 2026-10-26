import { expect, test } from "bun:test";
import { REDACTED, createPayloadRedactor } from "@lando/sdk/secrets";
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
