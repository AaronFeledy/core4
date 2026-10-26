import { expect, test } from "bun:test";
import {
  REDACTED,
  createPayloadRedactor,
  isPublicDefaultCredential,
  isUsableExactRedactionValue,
} from "@lando/sdk/secrets";
import { Effect } from "effect";
import { makeRedactionService } from "../src/service.ts";

test("payload values combine resolved values, tokens and late registrations without heuristic defaults", async () => {
  // Given
  const service = makeRedactionService();
  await Effect.runPromise(service.registerValues(["store-value"]));
  const getValues = await Effect.runPromise(
    service.payloadValues({
      redactionTokens: ["plan-value"],
      sourceEnv: { DB_PASSWORD: "landolando", AGENT_TOKEN: "agent-value" },
    }),
  );
  const redactor = createPayloadRedactor(getValues);
  const initial = getValues();
  // When
  await Effect.runPromise(service.registerValues(["late-value"]));
  const bytes = redactor.write(
    new TextEncoder().encode("store-value plan-value agent-value late-value landolando!"),
  );
  // Then
  expect(new TextDecoder().decode(bytes)).toBe(`${REDACTED} ${REDACTED} ${REDACTED} ${REDACTED} landolando!`);
  expect(getValues()).not.toBe(initial);
  expect(getValues()).toBe(getValues());
});

test.each([
  "lando",
  "landolando",
  "",
  " \t",
  "32",
  "1234",
  "38;2;255;0;0",
  "a",
  "☃",
  "12345678",
  "private-value",
  "LANDO",
  " lando ",
] as const)("payload masks exactly the usable values the string layer masks for %j", async (value) => {
  // Given
  const text = `<>${value}<>`;
  const masked = `<>${REDACTED}<>`;
  for (const source of ["resolved", "plan", "env", "registered"] as const) {
    const service = makeRedactionService();
    if (source === "resolved") await Effect.runPromise(service.registerValues([value]));
    const options = {
      redactionTokens: source === "plan" ? [value] : [],
      sourceEnv: source === "env" ? { AGENT_TOKEN: value } : {},
    };
    const getValues = await Effect.runPromise(service.payloadValues(options));
    const strings = await Effect.runPromise(service.forProfile("secrets", options));
    // When
    if (source === "registered") await Effect.runPromise(service.registerValues([value]));
    const payload = createPayloadRedactor(getValues);
    const bytes = new TextEncoder().encode(text);
    const first = payload.write(bytes.subarray(0, 9));
    const second = payload.write(bytes.subarray(9));
    const output = Buffer.concat([first, second, payload.flush()]).toString();
    // Then: heuristic sources drop public defaults; explicit sources keep them.
    const heuristic = source === "env";
    const authority = source === "resolved" || source === "registered";
    const eligible = authority
      ? value.length > 0
      : value.trim().length > 0 &&
        isUsableExactRedactionValue(value) &&
        !(heuristic && isPublicDefaultCredential(value));
    expect(output).toBe(eligible ? masked : text);
    if (authority && value.length > 0 && !isUsableExactRedactionValue(value))
      expect(strings.redactString(text)).toBe(REDACTED);
    else if (eligible) expect(strings.redactString(text)).toBe(masked);
    else expect(strings.redactString(text)).toBe(text);
  }
});
