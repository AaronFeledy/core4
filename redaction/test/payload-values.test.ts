import { afterEach, expect, test } from "bun:test";
import { REDACTED, createPayloadRedactor } from "@lando/sdk/secrets";
import { Effect } from "effect";
import { makeRedactionService, resetRegisteredRedactionValuesForTesting } from "../src/service.ts";

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

test("a published default is still masked when the store explicitly resolves it", async () => {
  // Given
  const service = makeRedactionService({
    id: "fixture",
    get: () => Effect.succeed("lando"),
    has: () => Effect.succeed(true),
    list: Effect.succeed(["fixture"]),
  });
  const getValues = await Effect.runPromise(service.payloadValues());
  // When
  const output = createPayloadRedactor(getValues).write(new TextEncoder().encode("lando!"));
  // Then
  expect(new TextDecoder().decode(output)).toBe(`${REDACTED}!`);
});
