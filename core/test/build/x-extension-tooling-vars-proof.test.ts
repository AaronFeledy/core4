import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { JsonSchema, JsonValue } from "../../../scripts/schema-compatibility/model.ts";
import { normalizeJsonSchema } from "../../../scripts/schema-compatibility/normalize.ts";
import { toolingVarsDeltas } from "./fixtures/x-extension-tooling-vars.delta.ts";
import { evolveHistoricalToolingVars } from "./x-extension-tooling-vars-proof.ts";

test("pins the independently modeled tooling vars projections", () => {
  expect(createHash("sha256").update(JSON.stringify(toolingVarsDeltas)).digest("hex")).toBe(
    "5c832eab30eb04c42b13ada80c77136e1b6cac9d05cb00600f2d16ecbd4fa838",
  );
});

for (const { mode, before, task, defaults } of toolingVarsDeltas) {
  const withVars = (fields: JsonSchema, vars: JsonValue): JsonSchema => ({
    type: "object",
    properties: { ...fields, vars },
    additionalProperties: false,
  });
  const taskFields = { cmd: { type: "string" }, service: { type: "string" } };
  const defaultsFields = { service: { type: "string" } };

  test(`replays the reviewed ${mode} task vars`, () => {
    const historical = withVars(taskFields, before);
    const snapshot = structuredClone(historical);
    expect(evolveHistoricalToolingVars(historical)).toEqual(normalizeJsonSchema(withVars(taskFields, task)));
    expect(historical).toEqual(snapshot);
  });

  test(`keeps only literals in the reviewed ${mode} toolingDefaults vars`, () => {
    expect(evolveHistoricalToolingVars(withVars(defaultsFields, before))).toEqual(
      normalizeJsonSchema(withVars(defaultsFields, defaults)),
    );
  });

  test(`does not change an unreviewed ${mode} vars projection`, () => {
    const input = withVars(taskFields, { ...before, maxProperties: 3 });
    expect(evolveHistoricalToolingVars(input)).toEqual(normalizeJsonSchema(input));
  });
}
