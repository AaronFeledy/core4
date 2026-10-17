import { afterEach, expect, test } from "bun:test";
import { REDACTED, createPayloadRedactor } from "@lando/sdk/secrets";
import { Effect } from "effect";
import {
  collectForwardedEnvValues,
  makeRedactionService,
  resetRegisteredRedactionValuesForTesting,
} from "../src/service.ts";

afterEach(resetRegisteredRedactionValuesForTesting);

test("payload values combine the store, tokens and late registrations without heuristic defaults", async () => {
  // Given
  const service = makeRedactionService({
    id: "fixture",
    get: () => Effect.succeed("store-value"),
    has: () => Effect.succeed(true),
    list: Effect.succeed(["fixture"]),
  });
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
  ["lando", false],
  ["landolando", false],
  ["", false],
  [" \t", false],
  ["32", false],
  ["1234", false],
  ["38;2;255;0;0", false],
  ["a", true],
  ["☃", true],
  ["12345678", true],
  ["private-value", true],
  ["LANDO", true],
  [" lando ", true],
] as const)("string and payload layers share eligibility for %j", async (value, eligible) => {
  // Given
  const text = `<>${value}<>`;
  const expected = eligible ? `<>${REDACTED}<>` : text;
  for (const source of ["store", "plan", "env", "registered", "forwarded"] as const) {
    resetRegisteredRedactionValuesForTesting();
    const service = makeRedactionService({
      id: "fixture",
      get: () => Effect.succeed(value),
      has: () => Effect.succeed(source === "store"),
      list: Effect.succeed(source === "store" ? ["fixture"] : []),
    });
    const options = {
      redactionTokens: source === "plan" ? [value] : [],
      sourceEnv: source === "env" ? { AGENT_TOKEN: value } : {},
    };
    const getValues = await Effect.runPromise(service.payloadValues(options));
    const strings = await Effect.runPromise(service.forProfile("secrets", options));
    // When
    if (source === "registered") await Effect.runPromise(service.registerValues([value]));
    if (source === "forwarded") {
      await Effect.runPromise(service.registerValues(collectForwardedEnvValues({ OPAQUE: value })));
    }
    const payload = createPayloadRedactor(getValues);
    const bytes = new TextEncoder().encode(text);
    const first = payload.write(bytes.subarray(0, 9));
    const second = payload.write(bytes.subarray(9));
    const output = Buffer.concat([first, second, payload.flush()]).toString();
    // Then
    expect(strings.redactString(text)).toBe(expected);
    expect(output).toBe(expected);
  }
});
