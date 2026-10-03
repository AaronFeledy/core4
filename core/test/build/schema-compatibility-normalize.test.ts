import { describe, expect, test } from "bun:test";
import { classifySchemaChange } from "../../../scripts/schema-compatibility/classifier.ts";
import type { JsonSchema, JsonValue } from "../../../scripts/schema-compatibility/model.ts";
import { normalizeJsonSchema } from "../../../scripts/schema-compatibility/normalize.ts";

describe("meaning-preserving schema normalization", () => {
  test.each([
    ["primitive types", [{ type: "string" }, { type: "number" }, { type: "null" }], true],
    ["integer and string", [{ type: "integer" }, { type: "string" }], true],
    ["distinct constants", [{ const: null }, { const: "null" }], true],
    ["disjoint enums", [{ enum: [1, 2] }, { enum: [3, 4] }], true],
    ["constant and enum", [{ const: "a" }, { enum: ["b", "c"] }], true],
    ["integer overlaps number", [{ type: "integer" }, { type: "number" }], false],
    ["duplicate branches", [{ type: "string" }, { type: "string" }], false],
    ["overlapping enums", [{ enum: [1, 2] }, { enum: [2, 3] }], false],
    ["equal object constants", [{ const: { a: 1, b: 2 } }, { const: { b: 2, a: 1 } }], false],
    ["unconstrained branch", [{ type: "string" }, {}], false],
    ["boolean true branch", [{ type: "string" }, true], false],
    ["only some pairs disjoint", [{ type: "number" }, { type: "string" }, { type: "integer" }], false],
  ] satisfies ReadonlyArray<readonly [string, readonly JsonValue[], boolean]>)(
    "proves union equivalence only for %s",
    (_name, branches, equivalent) => {
      // Given the same branches under exclusive and inclusive union operators.
      const before = { oneOf: branches };
      const after = { anyOf: branches };
      // When the classifier compares the accepted values.
      const findings = classifySchemaChange(before, after, "strict");
      // Then only proven pairwise disjointness removes the finding.
      if (equivalent) expect(normalizeJsonSchema(before)).toEqual(normalizeJsonSchema(after));
      else expect(normalizeJsonSchema(before)).not.toEqual(normalizeJsonSchema(after));
      expect(findings.length === 0).toBe(equivalent);
      expect(findings.every((finding) => !finding.accepted)).toBe(true);
    },
  );

  test.each([
    ["required shared tag", "object", ["kind"], ["kind"], "kind", true],
    ["optional tag", "object", [], [], "kind", false],
    ["one optional tag", "object", ["kind"], [], "kind", false],
    ["different tags", "object", ["kind"], ["other"], "other", false],
    ["non-object values also match", undefined, ["kind"], ["kind"], "kind", false],
  ] as const)("proves tagged union equivalence only with %s", (_name, type, left, right, tag, equivalent) => {
    // Given distinct tags, with object type and requiredness varied independently.
    const branches = [
      { ...(type ? { type } : {}), properties: { kind: { const: "a" } }, required: [...left] },
      { ...(type ? { type } : {}), properties: { [tag]: { const: "b" } }, required: [...right] },
    ];
    // When the union spelling changes.
    const findings = classifySchemaChange({ oneOf: branches }, { anyOf: branches }, "strict");
    // Then only mandatory shared tags on objects establish disjointness.
    expect(findings.length === 0).toBe(equivalent);
  });

  test.each([
    ["omitted", {}, true],
    ["true", { additionalProperties: true }, true],
    ["empty", { additionalProperties: {} }, true],
    ["closed", { additionalProperties: false }, false],
    ["constrained", { additionalProperties: { type: "string" } }, false],
  ] satisfies ReadonlyArray<readonly [string, JsonSchema, boolean]>)(
    "drops empty patterns only when additional properties are unrestricted: %s",
    (_name, extra, equivalent) => {
      // Given overlapping patterns: every matching constraint applies, not just the first.
      const before = { ...extra, patternProperties: { "^x-": {}, "^x-a": { type: "number" }, "^y-": true } };
      const after = { ...extra, patternProperties: { "^x-a": { type: "number" } } };
      // When empty branches are removed.
      const findings = classifySchemaChange(before, after, "strict");
      // Then no keys may become exposed to constrained additionalProperties.
      expect(findings.length === 0).toBe(equivalent);
    },
  );

  test.each([false, { type: "string" }, { minLength: 1 }])(
    "retains restricting pattern branch %j",
    (branch) => {
      // Given a restricting branch under an otherwise open object.
      const before = { patternProperties: { "^x-": branch } };
      // When it disappears.
      const findings = classifySchemaChange(before, {}, "strict");
      // Then constraint loss remains unaccepted.
      expect(findings).toEqual([expect.objectContaining({ verdict: "unknown", accepted: false })]);
    },
  );

  test.each([
    [
      "singleton reference allOf",
      { type: "string" },
      {
        allOf: [{ $ref: "#/definitions/Text" }],
        definitions: { Text: { type: "string" } },
      },
    ],
    [
      "annotation-only checks",
      { type: "integer", minimum: 1, maximum: 65535 },
      {
        type: "integer",
        minimum: 1,
        maximum: 65535,
        allOf: [{ description: "a value between 1 and 65535" }],
      },
    ],
    [
      "scalar check intersection",
      { type: "string", minLength: 1, pattern: "^/" },
      {
        type: "string",
        allOf: [{ minLength: 1 }, { pattern: "^/" }],
      },
    ],
    [
      "empty object keywords",
      { type: "object" },
      {
        type: "object",
        required: [],
        properties: {},
        patternProperties: {},
        dependentSchemas: {},
      },
    ],
    [
      "unconstrained additional properties",
      { type: "object" },
      {
        type: "object",
        additionalProperties: {},
      },
    ],
    [
      "boolean additional properties",
      { type: "object" },
      {
        type: "object",
        additionalProperties: true,
      },
    ],
    [
      "unconstrained array items",
      { type: "array" },
      {
        type: "array",
        items: {},
        additionalItems: true,
      },
    ],
    [
      "union ordering",
      { anyOf: [{ type: "string" }, { type: "null" }] },
      {
        anyOf: [{ type: "null" }, { type: "string" }],
      },
    ],
    [
      "nested unions",
      { anyOf: [{ type: "boolean" }, { type: "number" }, { type: "string" }] },
      {
        anyOf: [{ anyOf: [{ type: "string" }, { type: "boolean" }] }, { type: "number" }],
      },
    ],
    [
      "duplicate union branches",
      { anyOf: [{ type: "string" }, { type: "null" }] },
      {
        anyOf: [{ type: "string" }, { type: "null" }, { type: "string" }],
      },
    ],
    [
      "nullable type arrays",
      { anyOf: [{ type: "string" }, { type: "null" }] },
      {
        type: ["null", "string"],
      },
    ],
    [
      "optional object fields",
      { type: "object", properties: { value: { type: "string" } } },
      {
        type: "object",
        properties: { value: { allOf: [{ type: "string" }] } },
        required: [],
      },
    ],
    ["escaped regex delimiter", { type: "string", pattern: "^/" }, { type: "string", pattern: "^\\/" }],
    [
      "string-only property names",
      { type: "object", additionalProperties: { type: "string" } },
      {
        type: "object",
        propertyNames: { type: "string" },
        additionalProperties: { type: "string" },
      },
    ],
    ["unconstrained property names", { type: "object" }, { type: "object", propertyNames: {} }],
    [
      "universal record pattern",
      { type: "object", additionalProperties: { type: "string" } },
      {
        type: "object",
        patternProperties: { "": { type: "string" } },
      },
    ],
    [
      "closed tuple length",
      { type: "array", items: [{ type: "string" }], maxItems: 1 },
      {
        type: "array",
        items: [{ type: "string" }],
        additionalItems: false,
      },
    ],
    [
      "matching named and record constraints",
      {
        type: "object",
        properties: { known: { type: "string" } },
        additionalProperties: { type: "string" },
      },
      {
        type: "object",
        properties: { known: { type: "string" } },
        allOf: [{ type: "object", additionalProperties: { type: "string" } }],
      },
    ],
  ] satisfies ReadonlyArray<readonly [string, JsonSchema, JsonSchema]>)(
    "normalizes %s without changing meaning",
    (_name, before, after) => {
      // Given equivalent schema fixtures.
      // When both documents pass through the same normalizer.
      const normalized = normalizeJsonSchema(after);
      // Then canonical forms agree and the classifier reports no change.
      expect(normalized).toEqual(normalizeJsonSchema(before));
      expect(classifySchemaChange(before, after, "strict")).toEqual([]);
    },
  );

  test.each([
    ["removed pattern", { type: "string", pattern: "^x-" }, { type: "string" }],
    ["removed minLength", { type: "string", minLength: 1 }, { type: "string" }],
    ["unknown extension", { "x-constraint": true }, {}],
    [
      "unevaluated properties",
      { unevaluatedProperties: false, allOf: [{ patternProperties: { "^x-": {} } }] },
      { unevaluatedProperties: false },
    ],
    ["removed format", { type: "string", format: "ip" }, { type: "string" }],
    [
      "removed property name constraint",
      { type: "object", propertyNames: { type: "string", pattern: "^x-" } },
      { type: "object", propertyNames: { type: "string" } },
    ],
    ["closed object", { type: "object", additionalProperties: false }, { type: "object" }],
    [
      "changed check",
      { type: "integer", minimum: 1 },
      {
        type: "integer",
        allOf: [{ minimum: 2, description: "a value greater than or equal to 2" }],
      },
    ],
    ["nullable widening", { type: "string" }, { type: ["string", "null"] }],
    [
      "required field",
      { type: "object", properties: { a: { type: "string" } } },
      {
        type: "object",
        properties: { a: { type: "string" } },
        required: ["a"],
      },
    ],
    [
      "object applicator scope",
      { type: "object", properties: { a: { type: "string" } }, additionalProperties: false },
      {
        allOf: [{ type: "object", properties: { a: { type: "string" } } }, { additionalProperties: false }],
      },
    ],
    [
      "oneOf multiplicity",
      { oneOf: [{ type: "string" }] },
      {
        oneOf: [{ type: "string" }, { type: "string" }],
      },
    ],
    [
      "different named and record constraints",
      {
        type: "object",
        properties: { known: { type: "number" } },
        additionalProperties: { type: "string" },
      },
      {
        type: "object",
        properties: { known: { type: "number" } },
        allOf: [{ type: "object", additionalProperties: { type: "string" } }],
      },
    ],
    ["regex literal backslash", { type: "string", pattern: "^\\\\/" }, { type: "string", pattern: "^\\/" }],
  ] satisfies ReadonlyArray<readonly [string, JsonSchema, JsonSchema]>)(
    "still reports %s as a semantic change",
    (_name, before, after) => {
      // Given schemas accepting different JSON values.
      // When compared after normalization.
      const findings = classifySchemaChange(before, after, "strict");
      // Then no representation rewrite masks the changed contract.
      expect(findings.length).toBeGreaterThan(0);
      expect(
        findings.every((finding) => finding.verdict === "unknown" || finding.verdict === "breaking"),
      ).toBe(true);
    },
  );
});
