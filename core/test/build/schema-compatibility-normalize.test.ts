import { describe, expect, test } from "bun:test";
import { classifySchemaChange } from "../../../scripts/schema-compatibility/classifier.ts";
import type { JsonSchema } from "../../../scripts/schema-compatibility/model.ts";
import { normalizeJsonSchema } from "../../../scripts/schema-compatibility/normalize.ts";

describe("meaning-preserving schema normalization", () => {
  test.each([
    ["singleton reference allOf", { type: "string" }, {
      allOf: [{ $ref: "#/definitions/Text" }], definitions: { Text: { type: "string" } },
    }],
    ["annotation-only checks", { type: "integer", minimum: 1, maximum: 65535 }, {
      type: "integer", minimum: 1, maximum: 65535,
      allOf: [{ description: "a value between 1 and 65535" }],
    }],
    ["scalar check intersection", { type: "string", minLength: 1, pattern: "^/" }, {
      type: "string", allOf: [{ minLength: 1 }, { pattern: "^/" }],
    }],
    ["empty object keywords", { type: "object" }, {
      type: "object", required: [], properties: {}, patternProperties: {}, dependentSchemas: {},
    }],
    ["unconstrained additional properties", { type: "object" }, {
      type: "object", additionalProperties: {},
    }],
    ["boolean additional properties", { type: "object" }, {
      type: "object", additionalProperties: true,
    }],
    ["unconstrained array items", { type: "array" }, {
      type: "array", items: {}, additionalItems: true,
    }],
    ["union ordering", { anyOf: [{ type: "string" }, { type: "null" }] }, {
      anyOf: [{ type: "null" }, { type: "string" }],
    }],
    ["nested unions", { anyOf: [{ type: "boolean" }, { type: "number" }, { type: "string" }] }, {
      anyOf: [{ anyOf: [{ type: "string" }, { type: "boolean" }] }, { type: "number" }],
    }],
    ["duplicate union branches", { anyOf: [{ type: "string" }, { type: "null" }] }, {
      anyOf: [{ type: "string" }, { type: "null" }, { type: "string" }],
    }],
    ["nullable type arrays", { anyOf: [{ type: "string" }, { type: "null" }] }, {
      type: ["null", "string"],
    }],
    ["optional object fields", { type: "object", properties: { value: { type: "string" } } }, {
      type: "object", properties: { value: { allOf: [{ type: "string" }] } }, required: [],
    }],
    ["escaped regex delimiter", { type: "string", pattern: "^/" }, { type: "string", pattern: "^\\/" }],
    ["universal record pattern", { type: "object", additionalProperties: { type: "string" } }, {
      type: "object", patternProperties: { "": { type: "string" } },
    }],
    ["closed tuple length", { type: "array", items: [{ type: "string" }], maxItems: 1 }, {
      type: "array", items: [{ type: "string" }], additionalItems: false,
    }],
    ["matching named and record constraints", {
      type: "object", properties: { known: { type: "string" } }, additionalProperties: { type: "string" },
    }, {
      type: "object", properties: { known: { type: "string" } },
      allOf: [{ type: "object", additionalProperties: { type: "string" } }],
    }],
  ] satisfies ReadonlyArray<readonly [string, JsonSchema, JsonSchema]>) (
    "normalizes %s without changing meaning", (_name, before, after) => {
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
    ["removed format", { type: "string", format: "ip" }, { type: "string" }],
    ["closed object", { type: "object", additionalProperties: false }, { type: "object" }],
    ["changed check", { type: "integer", minimum: 1 }, {
      type: "integer", allOf: [{ minimum: 2, description: "a value greater than or equal to 2" }],
    }],
    ["nullable widening", { type: "string" }, { type: ["string", "null"] }],
    ["required field", { type: "object", properties: { a: { type: "string" } } }, {
      type: "object", properties: { a: { type: "string" } }, required: ["a"],
    }],
    ["object applicator scope", { type: "object", properties: { a: { type: "string" } }, additionalProperties: false }, {
      allOf: [{ type: "object", properties: { a: { type: "string" } } }, { additionalProperties: false }],
    }],
    ["oneOf multiplicity", { oneOf: [{ type: "string" }] }, {
      oneOf: [{ type: "string" }, { type: "string" }],
    }],
    ["different named and record constraints", {
      type: "object", properties: { known: { type: "number" } }, additionalProperties: { type: "string" },
    }, {
      type: "object", properties: { known: { type: "number" } },
      allOf: [{ type: "object", additionalProperties: { type: "string" } }],
    }],
    ["regex literal backslash", { type: "string", pattern: "^\\\\/" }, { type: "string", pattern: "^\\/" }],
  ] satisfies ReadonlyArray<readonly [string, JsonSchema, JsonSchema]>) (
    "still reports %s as a semantic change", (_name, before, after) => {
      // Given schemas accepting different JSON values.
      // When compared after normalization.
      const findings = classifySchemaChange(before, after, "strict");
      // Then no representation rewrite masks the changed contract.
      expect(findings.length).toBeGreaterThan(0);
      expect(findings.every((finding) => finding.verdict === "unknown" || finding.verdict === "breaking")).toBe(true);
    },
  );
});
