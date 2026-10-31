import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { normalizeJsonSchema } from "../../../scripts/schema-compatibility/normalize.ts";
import { consolePortDeltas } from "./fixtures/x-extension-console-port.delta.ts";
import { evolveHistoricalConsolePort } from "./x-extension-console-port-proof.ts";

test("pins the independently modeled console port projections", () => {
  // Given the reviewed bare, expression, and directive projections.
  const serialized = JSON.stringify(consolePortDeltas);
  // When their normalized model is hashed independently of live service schemas.
  const digest = createHash("sha256").update(serialized).digest("hex");
  // Then any unreviewed model change requires a new review.
  expect(digest).toBe("58ce8f7562c87ca80f847b8ef8d201151db30e1da6ba116d62c919769da613f1");
});

for (const { mode, field } of consolePortDeltas) {
  const historical = {
    type: "object",
    properties: { type: { type: "string" }, image: { type: "string" }, ports: {}, port: field },
    required: ["type"],
    additionalProperties: false,
  };

  test(`adds only an optional console port to the reviewed ${mode} service projection`, () => {
    // Given an independently modeled service and an unrelated constrained sibling.
    const input = { ...historical, properties: { ...historical.properties, sibling: { minLength: 7 } } };
    const before = structuredClone(input);
    // When console-port evolution follows the other historical deltas.
    const evolved = evolveHistoricalConsolePort(input);
    // Then the complete object changes only by the optional addition, without mutating its input.
    expect(evolved).toEqual(
      normalizeJsonSchema({
        ...input,
        properties: { ...input.properties, consolePort: field },
      }),
    );
    expect(input).toEqual(before);
  });

  test(`preserves an unreviewed ${mode} port constraint`, () => {
    // Given a service whose historical port differs from the pinned projection.
    const input = { ...historical, properties: { ...historical.properties, port: { ...field, minimum: 7 } } };
    // When the delta attempts to recognize the service.
    const evolved = evolveHistoricalConsolePort(input);
    // Then it cannot hide the difference by accepting the new field.
    expect(evolved).toEqual(normalizeJsonSchema(input));
  });

  test(`preserves an already constrained ${mode} console port`, () => {
    // Given a service with an independently tightened console contract.
    const input = {
      ...historical,
      properties: { ...historical.properties, consolePort: { type: "number", minimum: 7 } },
    };
    // When the optional-field delta runs again.
    const evolved = evolveHistoricalConsolePort(input);
    // Then it leaves the existing constraint intact rather than replacing it.
    expect(evolved).toEqual(normalizeJsonSchema(input));
  });

  test(`does not add console ports to an unrelated ${mode} object`, () => {
    // Given a same-shaped port outside a service object.
    const input = { type: "object", properties: { port: field, protocol: { type: "string" } } };
    // When console-port evolution visits it.
    const evolved = evolveHistoricalConsolePort(input);
    // Then the unrelated contract is unchanged.
    expect(evolved).toEqual(normalizeJsonSchema(input));
  });
}
