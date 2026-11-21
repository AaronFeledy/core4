import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { normalizeJsonSchema } from "../../../scripts/schema-compatibility/normalize.ts";
import { extraArgsDeltas } from "./fixtures/x-extension-extra-args.delta.ts";
import { evolveHistoricalExtraArgs } from "./x-extension-extra-args-proof.ts";

test("pins the independently modeled extraArgs projections", () => {
  expect(createHash("sha256").update(JSON.stringify(extraArgsDeltas)).digest("hex")).toBe(
    "86f541de6d7a34cd82c017b2885d55764ddc10fa6ff0f0b89476343362be91ca",
  );
});

for (const { mode, field, witness: consolePort } of extraArgsDeltas) {
  const service = {
    type: "object",
    properties: { type: { type: "string" }, image: { type: "string" }, ports: {}, consolePort },
    required: ["type"],
    additionalProperties: false,
  };
  const unrelated = { type: "object", properties: { consolePort } };
  test(`adds only optional extraArgs to the reviewed ${mode} service`, () => {
    const historical = { anyOf: [unrelated, service] };
    const before = structuredClone(historical);
    const evolved = evolveHistoricalExtraArgs(historical);
    expect(evolved).toEqual(
      normalizeJsonSchema({
        anyOf: [unrelated, { ...service, properties: { ...service.properties, extraArgs: field } }],
      }),
    );
    expect(historical).toEqual(before);
  });
  test(`preserves a tampered ${mode} extraArgs so the drift stays detectable`, () => {
    const input = { ...service, properties: { ...service.properties, extraArgs: { type: "number" } } };
    const evolved = evolveHistoricalExtraArgs(input);
    expect(evolved).toEqual(normalizeJsonSchema(input));
    expect(evolved).not.toEqual(evolveHistoricalExtraArgs(service));
  });
  test(`does not change an unreviewed ${mode} projection`, () => {
    const input = { ...service, properties: { ...service.properties, consolePort: { minimum: 7 } } };
    expect(evolveHistoricalExtraArgs(input)).toEqual(normalizeJsonSchema(input));
  });
}
