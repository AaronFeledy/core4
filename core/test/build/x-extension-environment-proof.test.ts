import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Schema } from "effect";
import { jsonEquals } from "../../../scripts/schema-compatibility/model.ts";
import { normalizeJsonSchema } from "../../../scripts/schema-compatibility/normalize.ts";
import { environmentDeltas } from "./fixtures/x-extension-environment.delta.ts";
import { historicalExpressionSlot } from "./fixtures/x-extension-historical-expression.ts";
import { evolveHistoricalEnvironment } from "./x-extension-environment-proof.ts";
import { wireObject } from "./x-extension-wire-proof.ts";

test("pins the reviewed value-model delta independently of live environment schemas", () => {
  expect(createHash("sha256").update(JSON.stringify(environmentDeltas)).digest("hex")).toBe(
    "dc106c16b4329027cbd921465ab9f25ff6838a0f9184e8734dbf8e399a427f6c",
  );
  expect(environmentDeltas).toHaveLength(6);
});

for (const [index, { mode, before, after }] of environmentDeltas.entries()) {
  const surface = mode === "bare" ? "bare" : "authoring";
  test(`replays exact value fields without changing their surrounding projection ${index}`, () => {
    // Given independently modeled historical fields and unchanged siblings.
    const properties = wireObject(before.properties);
    const sibling = { type: "number", minimum: 7 };
    const input = { ...before, properties: { ...properties, unrelated: sibling } };
    const copy = structuredClone(input);
    // When the reviewed delta follows the real authoring projection.
    const evolved = evolveHistoricalEnvironment(input, surface);
    // Then all field shapes change exactly, with no sibling or required-key change.
    expect(evolved).toEqual(
      normalizeJsonSchema({ ...after, properties: { ...wireObject(after.properties), unrelated: sibling } }),
    );
    expect(input).toEqual(copy);
    expect(evolved.required).toEqual(before.required);
    expect(evolved.additionalProperties).toBe(false);
  });

  for (const [field, schema] of Object.entries(wireObject(before.properties))) {
    test(`preserves unreviewed historical constraints on ${field} in projection ${index}`, () => {
      // Given a field that no longer equals the reviewed historical contract.
      const changed = { ...wireObject(schema), minProperties: 999 };
      const input = { ...before, properties: { [field]: changed } };
      // When replay attempts an exact field match.
      const evolved = evolveHistoricalEnvironment(input, surface);
      // Then the constraint is not erased by a replacement.
      expect(wireObject(evolved.properties)[field]).toEqual(normalizeJsonSchema(changed));
      expect(jsonEquals(evolved, after)).toBe(false);
    });

    test(`does not confuse a same-shaped unrelated field with ${field} in projection ${index}`, () => {
      const input = { type: "object", properties: { unrelated: schema } };
      expect(evolveHistoricalEnvironment(input, surface)).toEqual(normalizeJsonSchema(input));
    });
  }
}

test("historical expression slots never reuse the shared Schema.String AST", () => {
  // Given / When: the frozen slots for kinds that historically projected to plain strings.
  const slots = ["string", "unknown"].map((kind) => historicalExpressionSlot(kind).ast);
  // Then: slot registration cannot mark every plain string in the process as an expression slot.
  for (const ast of slots) expect(ast).not.toBe(Schema.String.ast);
});
