import { expect, test } from "bun:test";
import { ExecAppResult, JSON_SCHEMA_NAMES } from "@lando/sdk/schema";
import { Schema } from "effect";

import { classifySchemaChange } from "../../../scripts/schema-compatibility/classifier.ts";
import {
  type JsonSchema,
  type SchemaPolarity,
  isJsonObject,
} from "../../../scripts/schema-compatibility/model.ts";
import { schemaPolarity } from "../../../scripts/schema-compatibility/polarity.ts";

const oldMembers = [{ type: "boolean" }, { type: "object", properties: { command: { type: "string" } } }];
const newMembers = [{ type: "string" }, ...oldMembers];

test("proves the published ObjectKeyword to ExecAppResult output narrowing", () => {
  // Given
  const before = Schema.toJsonSchemaDocument(Schema.ObjectKeyword).schema;
  const after = Schema.toJsonSchemaDocument(ExecAppResult).schema;
  if (!isJsonObject(before) || !isJsonObject(after)) throw new Error("Expected object schema documents.");
  // When
  const findings = classifySchemaChange(before, after, "output");
  // Then
  expect(findings).toMatchObject([{ verdict: "compatible", changeKind: "union-narrowed", path: "$.anyOf" }]);
  expect(findings).toHaveLength(1);
});

const bareObject = { type: "object" };
const objectUnion = { anyOf: [{ type: "array" }, bareObject] };
test.each([
  ["collapsed single member", objectUnion, { anyOf: [bareObject] }, "output", "compatible", "union-narrowed"],
  [
    "closed output struct",
    objectUnion,
    {
      ...bareObject,
      additionalProperties: false,
      properties: { app: { type: "string" } },
      required: ["app"],
    },
    "output",
    "compatible",
    "union-narrowed",
  ],
  ["input widening", bareObject, objectUnion, "input", "compatible", "union-widened"],
  ["output widening", bareObject, objectUnion, "output", "unknown", "unsupported-construct"],
  ["input narrowing", objectUnion, bareObject, "input", "unknown", "unsupported-construct"],
  ["strict narrowing", objectUnion, bareObject, "strict", "unknown", "unsupported-construct"],
  [
    "constrained output wrapper",
    { ...objectUnion, maxProperties: 0 },
    bareObject,
    "output",
    "unknown",
    "unsupported-construct",
  ],
  [
    "constrained input wrapper",
    bareObject,
    { ...objectUnion, maxProperties: 0 },
    "input",
    "unknown",
    "unsupported-construct",
  ],
  [
    "closed branch",
    { anyOf: [{ type: "array" }, { ...bareObject, additionalProperties: false }] },
    { ...bareObject, additionalProperties: false, properties: { app: { type: "string" } } },
    "output",
    "unknown",
    "unsupported-construct",
  ],
  [
    "unresolved reference",
    { anyOf: [{ type: "array" }, { $ref: "missing" }] },
    { $ref: "missing" },
    "output",
    "unknown",
    "unsupported-construct",
  ],
  [
    "inconclusive branch",
    { anyOf: [{ type: "array" }, { ...bareObject, maxProperties: 0 }] },
    bareObject,
    "output",
    "unknown",
    "unsupported-construct",
  ],
  [
    "input property restriction",
    bareObject,
    { anyOf: [{ type: "array" }, { ...bareObject, properties: { app: { type: "string" } } }] },
    "input",
    "unknown",
    "unsupported-construct",
  ],
] satisfies ReadonlyArray<readonly [string, JsonSchema, JsonSchema, SchemaPolarity, string, string]>)(
  "%s uses only conclusive branch proofs",
  (_name, before, after, polarity, verdict, changeKind) => {
    // Given / When
    const findings = classifySchemaChange(before, after, polarity);
    // Then
    expect(findings).toMatchObject([{ verdict, changeKind, path: "$.anyOf" }]);
    expect(findings).toHaveLength(1);
  },
);

test("proves unchanged closed branches without opening their property set", () => {
  // Given
  const closed = { type: "object", additionalProperties: false };
  // When
  const findings = classifySchemaChange({ anyOf: [{ type: "array" }, closed] }, closed, "output");
  // Then
  expect(findings).toMatchObject([{ verdict: "compatible", changeKind: "union-narrowed" }]);
});

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

const overlappingMembers = [{ type: "number" }, { type: "integer" }];
const survivingOneOfCases = (
  [
    ["overlapping addition", overlappingMembers, [...overlappingMembers, { type: "number", minimum: 0 }]],
    ["duplicate addition", overlappingMembers, [...overlappingMembers, { type: "number" }]],
    [
      "duplicate plus distinct addition",
      overlappingMembers,
      [...overlappingMembers, ...overlappingMembers, { type: "string" }],
    ],
  ] as const
).flatMap(([name, before, after]) =>
  (["input", "output", "strict"] as const).flatMap(
    (polarity) =>
      [
        [name, polarity, "forward", { oneOf: before }, { oneOf: after }],
        [name, polarity, "reverse", { oneOf: after }, { oneOf: before }],
      ] as const,
  ),
);

test.each(survivingOneOfCases)(
  "keeps oneOf %s unknown under %s polarity in the %s direction",
  (_name, polarity, _direction, before, after) => {
    // Given / When
    const findings = classifySchemaChange(before, after, polarity);
    // Then
    expect(findings).toMatchObject([
      { verdict: "unknown", changeKind: "unsupported-construct", path: "$.oneOf" },
    ]);
  },
);

test.each(["input", "output", "strict"] satisfies readonly SchemaPolarity[])(
  "ignores oneOf ordering while preserving duplicates under %s polarity",
  (polarity) => {
    // Given
    const members = [...overlappingMembers, { type: "number" }];
    // When
    const findings = classifySchemaChange({ oneOf: members }, { oneOf: [...members].reverse() }, polarity);
    // Then
    expect(findings).toEqual([]);
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

test("keeps a union finding when a later construct also changes", () => {
  // Given
  const before: JsonSchema = { anyOf: oldMembers, allOf: [{ type: "object" }] };
  const after: JsonSchema = { anyOf: newMembers, allOf: [{ type: "object", minProperties: 1 }] };
  // When
  const findings = classifySchemaChange(before, after, "output");
  // Then
  expect(findings).toMatchObject([
    { verdict: "breaking", changeKind: "union-widened" },
    { verdict: "unknown", changeKind: "unsupported-construct" },
  ]);
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
