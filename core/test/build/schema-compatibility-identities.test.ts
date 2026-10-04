import { describe, expect, test } from "bun:test";
import { classifySchemaChange } from "../../../scripts/schema-compatibility/classifier.ts";
import type { JsonSchema } from "../../../scripts/schema-compatibility/model.ts";
import { normalizeJsonSchema } from "../../../scripts/schema-compatibility/normalize.ts";

describe("schema representation identities", () => {
  test.each([
    ["plain string alternative", { anyOf: [{ type: "string", pattern: "^a$" }, { type: "string" }] }, true],
    ["exclusive alternatives", { oneOf: [{ type: "string", pattern: "^a$" }, { type: "string" }] }, false],
    [
      "no unrestricted string",
      {
        anyOf: [
          { type: "string", pattern: "^a$" },
          { type: "string", minLength: 1 },
        ],
      },
      false,
    ],
    [
      "nullable alternative",
      { anyOf: [{ type: "string", pattern: "^a$" }, { type: "string" }, { type: "null" }] },
      false,
    ],
    [
      "number alternative",
      { anyOf: [{ type: "string", pattern: "^a$" }, { type: "string" }, { type: "number" }] },
      false,
    ],
    ["unresolved reference", { anyOf: [{ type: "string" }, { type: "string", $ref: "#/missing" }] }, false],
    [
      "sibling restriction",
      { anyOf: [{ type: "string", pattern: "^a$" }, { type: "string" }], minLength: 5 },
      false,
    ],
  ] satisfies ReadonlyArray<readonly [string, JsonSchema, boolean]>)(
    "preserves string union acceptance with %s",
    (_name, after, equivalent) => {
      const findings = classifySchemaChange({ type: "string" }, after, "strict");
      expect(findings.length === 0).toBe(equivalent);
      expect(findings.every((finding) => !finding.accepted)).toBe(true);
    },
  );

  test.each([
    ["homogeneous rest", {}, true],
    ["different rest", { additionalItems: { type: "number" } }, false],
    ["closed rest", { additionalItems: false }, false],
    ["unrestricted rest", { additionalItems: true }, false],
    ["different prefix", { items: [{ type: "number" }] }, false],
    ["different minimum", { minItems: 0 }, false],
    ["different maximum", { maxItems: 2 }, false],
  ] satisfies ReadonlyArray<readonly [string, JsonSchema, boolean]>)(
    "preserves array acceptance with %s",
    (_name, extra, equivalent) => {
      // Given an array with independent length and element constraints.
      const before = { type: "array", items: { type: "string" }, minItems: 1, maxItems: 3 };
      const after = { ...before, items: [{ type: "string" }], additionalItems: { type: "string" }, ...extra };
      // When a singleton tuple and its rest are normalized.
      const findings = classifySchemaChange(before, after, "strict");
      // Then only the homogeneous, length-preserving representation is equivalent.
      expect(findings.length === 0).toBe(equivalent);
      expect(findings.every((finding) => !finding.accepted)).toBe(true);
    },
  );

  test.each([
    ["alias-only edge", { $ref: "#/$defs/Node" }, true],
    ["constrained edge", { $ref: "#/$defs/Node", minProperties: 2 }, false],
    ["different target", { $ref: "#/$defs/Other" }, false],
  ] satisfies ReadonlyArray<readonly [string, JsonSchema, boolean]>)(
    "preserves recursive identity across %s",
    (_name, alias, equivalent) => {
      // Given a recursive node and an extra reference hop to the same or a different target.
      const node = {
        type: "object",
        properties: { value: { type: "string" }, next: { $ref: "#/$defs/Node" } },
      };
      const before = { $ref: "#/$defs/Node", $defs: { Node: node } };
      const after = {
        $ref: "#/$defs/Alias",
        $defs: {
          Alias: alias,
          Node: { ...node, properties: { ...node.properties, next: { $ref: "#/$defs/Alias" } } },
          Other: {
            type: "object",
            properties: { value: { type: "number" }, next: { $ref: "#/$defs/Alias" } },
          },
        },
      };
      // When only semantic nodes contribute to recursive target identity.
      const findings = classifySchemaChange(before, after, "strict");
      // Then aliases disappear but target changes and sibling constraints do not.
      expect(findings.length === 0).toBe(equivalent);
      expect(findings.every((finding) => !finding.accepted)).toBe(true);
    },
  );

  test("terminates an alias-only cycle without identifying it with an unconstrained schema", () => {
    // Given references that never reach a semantic target.
    const schema = { $ref: "#/$defs/A", $defs: { A: { $ref: "#/$defs/B" }, B: { $ref: "#/$defs/A" } } };
    // When resolving the cycle.
    const normalized = normalizeJsonSchema(schema);
    // Then the unresolved reference remains visible rather than becoming an accepting schema.
    expect(typeof normalized.$ref).toBe("string");
    expect(normalized).not.toEqual({});
  });

  test("distinguishes recursion to a parent target from recursion to the current target", () => {
    // Given the same two semantic nodes with a different recursive back edge.
    const parent = {
      type: "object",
      properties: { value: { const: "parent" }, next: { $ref: "#/$defs/Child" } },
    };
    const child = {
      type: "object",
      properties: { value: { const: "child" }, next: { $ref: "#/$defs/Parent" } },
    };
    const before = { $ref: "#/$defs/Parent", $defs: { Parent: parent, Child: child } };
    const after = {
      $ref: "#/$defs/Parent",
      $defs: {
        Parent: parent,
        Child: { ...child, properties: { ...child.properties, next: { $ref: "#/$defs/Child" } } },
      },
    };
    // When recursive targets are compared after alias removal.
    const findings = classifySchemaChange(before, after, "strict");
    // Then equal leaf constraints cannot hide the changed recursive structure.
    expect(findings).toEqual([expect.objectContaining({ verdict: "unknown", accepted: false })]);
  });
});
