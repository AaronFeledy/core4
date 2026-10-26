import { expect, test } from "bun:test";
import { mergeValues, resolveLayerMergeRule } from "@lando/sdk/landofile";
import { ServiceConfig } from "@lando/sdk/schema";
import { Result, Schema } from "effect";

test.each(["service_healthy", null, true, 42, ["service_started"]].map((spec) => ({ spec })))(
  "does not project malformed dependency map value $spec into a structured dependency",
  ({ spec }) => {
    // Given
    const value = { database: spec };
    const rule = resolveLayerMergeRule(ServiceConfig, ["dependsOn"]);
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
])("keeps malformed or reserved dependency map entries invalid after merging %j", (dependsOn) => {
  // Given
  const base = { dependsOn: [{ service: "cache" }] };
  // When
  const merged = mergeValues(ServiceConfig, base, { dependsOn });
  // Then
  expect(
    Result.isFailure(Schema.decodeUnknownResult(ServiceConfig)(merged, { onExcessProperty: "error" })),
  ).toBe(true);
  expect(merged).toEqual({ dependsOn });
});

test("merges valid dependency maps by service without repairing their other fields", () => {
  // Given
  const base = { dependsOn: [{ service: "database", condition: "service_started", required: false }] };
  const local = { dependsOn: { database: { condition: "service_healthy", restart: true } } };
  // When
  const merged = mergeValues(ServiceConfig, base, local);
  // Then
  expect(merged).toEqual({
    dependsOn: [{ service: "database", condition: "service_healthy", required: false, restart: true }],
  });
});
