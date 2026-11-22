import { expect, test } from "bun:test";
import { mergeValues, resolveLayerMergeRule } from "@lando/sdk/landofile";
import { ServiceConfig } from "@lando/sdk/schema";
import { Result, Schema } from "effect";

test.each(["service_healthy", null, true, 42, ["service_started"]].map((spec) => ({ spec })))(
  "does not project malformed dependency map value $spec into a structured dependency",
  ({ spec }) => {
    // Given
    const value = { database: spec };
    const rule = resolveLayerMergeRule(ServiceConfig, ["depends_on"]);
    // When
    const projected = rule.entries(value);
    // Then
    expect(projected).toBeUndefined();
  },
);

test.each([
  { database: "service_healthy" },
  Object.fromEntries([["__proto__", { condition: "service_started" }]]),
  { database: { service: "other", condition: "service_started" } },
])("keeps malformed or reserved dependency map entries invalid after merging %j", (depends_on) => {
  // Given
  const base = { depends_on: ["cache"] };
  // When
  const merged = mergeValues(ServiceConfig, base, { depends_on });
  // Then
  expect(
    Result.isFailure(Schema.decodeUnknownResult(ServiceConfig)(merged, { onExcessProperty: "error" })),
  ).toBe(true);
  expect(merged).toEqual({ depends_on });
});

test("merges valid dependency maps by service without repairing their other fields", () => {
  // Given
  const base = { depends_on: { database: { condition: "service_started", required: false } } };
  const local = { depends_on: { database: { condition: "service_healthy", restart: true } } };
  // When
  const merged = mergeValues(ServiceConfig, base, local);
  // Then normalized overlay merging emits a condition map, not a list of objects.
  expect(merged).toEqual({
    depends_on: { database: { condition: "service_healthy", required: false, restart: true } },
  });
});
