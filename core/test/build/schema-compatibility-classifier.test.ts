import { expect, test } from "bun:test";
import { JSON_SCHEMA_NAMES } from "@lando/sdk/schema";

import { classifySchemaChange } from "../../../scripts/schema-compatibility/classifier.ts";
import type { JsonSchema, SchemaPolarity } from "../../../scripts/schema-compatibility/model.ts";
import { schemaPolarity } from "../../../scripts/schema-compatibility/polarity.ts";

const oldMembers = [{ type: "boolean" }, { type: "object", properties: { command: { type: "string" } } }];
const newMembers = [{ type: "string" }, ...oldMembers];

const unionCases = (["anyOf", "oneOf"] as const).flatMap((keyword) => {
  const before: JsonSchema = { [keyword]: oldMembers };
  const after: JsonSchema = { [keyword]: newMembers };
  return [
    [keyword, "input", before, after, "compatible", "union-widened"],
    [keyword, "strict", before, after, "unknown", "unsupported-construct"],
    [keyword, "input", after, before, "breaking", "union-narrowed"],
    [keyword, "output", after, before, "compatible", "union-narrowed"],
    [keyword, "output", before, after, "breaking", "union-widened"],
  ] as const;
});
test.each(unionCases)(
  "%s under %s polarity classifies member-set changes",
  (_keyword, polarity, oldSchema, newSchema, verdict, changeKind) => {
    // Given
    // When
    const findings = classifySchemaChange(oldSchema, newSchema, polarity);
    // Then
    expect(findings).toMatchObject([{ verdict, changeKind }]);
  },
);

test.each(["input", "output", "strict"] satisfies readonly SchemaPolarity[])(
  "keeps mutated union members unsupported for %s polarity",
  (polarity) => {
    // Given
    const before = { anyOf: oldMembers };
    const after = { anyOf: [{ type: "boolean" }, { type: "array", items: { type: "string" } }] };
    // When
    const findings = classifySchemaChange(before, after, polarity);
    // Then
    expect(findings).toMatchObject([{ verdict: "unknown", changeKind: "unsupported-construct" }]);
  },
);

test("compares union members after reference expansion and annotation normalization", () => {
  // Given
  const before = {
    anyOf: [{ $ref: "#/$defs/Command" }, { type: "boolean" }],
    $defs: { Command: { type: "object", properties: { command: { type: "string" } }, description: "old" } },
  };
  const after = { anyOf: [...newMembers].reverse() };
  // When
  const findings = classifySchemaChange(before, after, "input");
  // Then
  expect(findings).toMatchObject([{ verdict: "compatible", changeKind: "union-widened" }]);
});

test.each([
  ...JSON_SCHEMA_NAMES.filter((name) => name.endsWith("ServiceConfig")),
  "ServiceConfigInput",
  "HealthcheckInput",
  "AppMountInput",
])("classifies %s as an author input contract", (name) => {
  // Given / When
  const polarity = schemaPolarity(name);
  // Then
  expect(polarity).toBe("input");
});

test.each(["input", "output", "strict"] satisfies readonly SchemaPolarity[])(
  "keeps inline-to-shared-definition publication compatible for %s polarity",
  (polarity) => {
    // Given
    const before = { type: "object", properties: { command: { type: "string" } } };
    const after = {
      type: "object",
      properties: { command: { $ref: "#/$defs/Command" } },
      $defs: { Command: { type: "string" }, Unused: { type: "number" } },
    };
    // When
    const findings = classifySchemaChange(before, after, polarity);
    // Then
    expect(findings).toEqual([]);
  },
);
