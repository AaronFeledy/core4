import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { normalizeJsonSchema } from "../../../scripts/schema-compatibility/normalize.ts";
import { noScriptsDeltas } from "./fixtures/x-extension-no-scripts.delta.ts";
import { evolveHistoricalNoScripts } from "./x-extension-no-scripts-proof.ts";

test("pins the independently modeled noScripts projections", () => {
  expect(createHash("sha256").update(JSON.stringify(noScriptsDeltas)).digest("hex")).toBe(
    "d0b24a968ac83248b0e9ecd0b87cb52f6e9886343a475234b169b7e7729de149",
  );
});

for (const { mode, field, witness: consolePort } of noScriptsDeltas) {
  const historical = {
    type: "object",
    properties: { type: { type: "string" }, image: { type: "string" }, ports: {}, consolePort },
    required: ["type"],
    additionalProperties: false,
  };
  test(`adds only optional noScripts to the reviewed ${mode} projection`, () => {
    const before = structuredClone(historical);
    const evolved = evolveHistoricalNoScripts(historical);
    expect(evolved).toEqual(
      normalizeJsonSchema({
        ...historical,
        properties: { ...historical.properties, noScripts: field },
      }),
    );
    expect(historical).toEqual(before);
  });
  test(`preserves already constrained ${mode} noScripts`, () => {
    const input = { ...historical, properties: { ...historical.properties, noScripts: { maxItems: 2 } } };
    expect(evolveHistoricalNoScripts(input)).toEqual(normalizeJsonSchema(input));
  });
  test(`does not change an unreviewed ${mode} projection`, () => {
    const input = { ...historical, properties: { ...historical.properties, consolePort: { minimum: 7 } } };
    expect(evolveHistoricalNoScripts(input)).toEqual(normalizeJsonSchema(input));
  });
}
