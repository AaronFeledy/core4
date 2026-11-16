import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { normalizeJsonSchema } from "../../../scripts/schema-compatibility/normalize.ts";
import { evolveHistoricalSchedule, scheduleDeltas } from "./x-extension-schedule-proof.ts";

test("pins the independently reviewed schedule projections", () => {
  expect(createHash("sha256").update(JSON.stringify(scheduleDeltas)).digest("hex")).toBe(
    "c0d5539bbd589cf250da0f5ef5d34f2a6f04649b4cb5fb898eb3e4467e5edf68",
  );
});

for (const { mode, field, witness: uploadDirs } of scheduleDeltas) {
  const historical = {
    type: "object",
    properties: { type: { type: "string" }, image: { type: "string" }, ports: {}, uploadDirs },
    required: ["type"],
    additionalProperties: false,
  };
  test(`adds only optional schedule to the reviewed ${mode} projection`, () => {
    const before = structuredClone(historical);
    const evolved = evolveHistoricalSchedule(historical);
    expect(evolved).toEqual(
      normalizeJsonSchema({
        ...historical,
        properties: { ...historical.properties, schedule: field },
      }),
    );
    expect(historical).toEqual(before);
  });
  test(`preserves already constrained ${mode} schedule`, () => {
    const input = { ...historical, properties: { ...historical.properties, schedule: { maxItems: 2 } } };
    expect(evolveHistoricalSchedule(input)).toEqual(normalizeJsonSchema(input));
  });
  test(`does not change an unreviewed ${mode} projection`, () => {
    const input = { ...historical, properties: { ...historical.properties, uploadDirs: { maxItems: 2 } } };
    expect(evolveHistoricalSchedule(input)).toEqual(normalizeJsonSchema(input));
  });
}
