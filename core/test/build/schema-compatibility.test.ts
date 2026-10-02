import { describe, expect, test } from "bun:test";

import { skippedFamilyNotices } from "../../../scripts/check-schema-compatibility.ts";
import {
  type CompatibilityException,
  type JsonSchema,
  acceptCompatibilityExceptions,
  classifySchemaChange,
} from "../../../scripts/schema-compatibility/classifier.ts";

const objectSchema = (
  properties: Readonly<Record<string, JsonSchema>>,
  required: ReadonlyArray<string> = [],
): JsonSchema => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

describe("schema compatibility classifier", () => {
  test.each([
    [
      "definitions location",
      { $ref: "#/$defs/Text", $defs: { Text: { type: "string" } } },
      { $ref: "#/definitions/Text", definitions: { Text: { type: "string" } } },
    ],
    [
      "reference names",
      { $ref: "#/$defs/Text", $defs: { Text: { type: "string" } } },
      { $ref: "#/definitions/0", definitions: { "0": { type: "string" } } },
    ],
    [
      "generated check descriptions",
      { anyOf: [{ type: "number", minimum: 1, description: "a number" }] },
      { anyOf: [{ description: "a value greater than or equal to 1", minimum: 1, type: "number" }] },
    ],
    [
      "key order",
      { type: "object", properties: { a: { type: "string" }, b: { type: "number" } }, required: ["a", "b"] },
      { required: ["b", "a"], properties: { b: { type: "number" }, a: { type: "string" } }, type: "object" },
    ],
    ["enum order", { type: "string", enum: ["b", "a"] }, { enum: ["a", "b"], type: "string" }],
    [
      "recursive reference names",
      {
        $ref: "#/$defs/Node",
        $defs: { Node: { type: "object", properties: { next: { $ref: "#/$defs/Node" } } } },
      },
      {
        $ref: "#/definitions/0",
        definitions: { "0": { type: "object", properties: { next: { $ref: "#/definitions/0" } } } },
      },
    ],
  ] satisfies ReadonlyArray<readonly [string, JsonSchema, JsonSchema]>)(
    "ignores %s when constraints are unchanged",
    (_name, before, after) => {
      // Given equivalent documents emitted by different generators.
      // When their meaning is compared.
      const findings = classifySchemaChange(before, after, "input");
      // Then representation differences do not require compatibility exceptions.
      expect(findings).toEqual([]);
    },
  );

  test("detects a changed constraint behind renamed references", () => {
    // Given definitions whose names and constraints both changed.
    const before = { $ref: "#/$defs/Text", $defs: { Text: { type: "string" } } };
    const after = { $ref: "#/definitions/0", definitions: { "0": { type: "number" } } };
    // When compared through the same normalization as generator-only changes.
    const findings = classifySchemaChange(before, after, "input");
    // Then the changed accepted value type is still breaking.
    expect(findings).toEqual([expect.objectContaining({ verdict: "breaking", changeKind: "type-changed" })]);
  });

  test("classifies an optional input property addition as compatible", () => {
    const before = objectSchema({ name: { type: "string" } }, ["name"]);
    const after = objectSchema({ name: { type: "string" }, port: { type: "number" } }, ["name"]);

    const findings = classifySchemaChange(before, after, "input");

    expect(findings).toEqual([
      expect.objectContaining({ verdict: "compatible", changeKind: "property-added", path: "$.port" }),
    ]);
  });

  test("classifies a required input property addition as breaking", () => {
    const before = objectSchema({ name: { type: "string" } }, ["name"]);
    const after = objectSchema({ name: { type: "string" }, port: { type: "number" } }, ["name", "port"]);

    const findings = classifySchemaChange(before, after, "input");

    expect(findings).toEqual([
      expect.objectContaining({ verdict: "breaking", changeKind: "property-added", path: "$.port" }),
    ]);
  });

  test("classifies an output property removal as breaking", () => {
    const before = objectSchema({ name: { type: "string" }, port: { type: "number" } }, ["name"]);
    const after = objectSchema({ name: { type: "string" } }, ["name"]);

    const findings = classifySchemaChange(before, after, "output");

    expect(findings).toEqual([
      expect.objectContaining({ verdict: "breaking", changeKind: "property-removed", path: "$.port" }),
    ]);
  });

  test("classifies an input enum narrowing as breaking", () => {
    const findings = classifySchemaChange(
      { type: "string", enum: ["alpha", "beta"] },
      { type: "string", enum: ["alpha"] },
      "input",
    );

    expect(findings).toEqual([
      expect.objectContaining({ verdict: "breaking", changeKind: "enum-narrowed", path: "$" }),
    ]);
  });

  test("classifies an input enum widening as compatible", () => {
    const findings = classifySchemaChange(
      { type: "string", enum: ["alpha"] },
      { type: "string", enum: ["alpha", "beta"] },
      "input",
    );

    expect(findings).toEqual([
      expect.objectContaining({ verdict: "compatible", changeKind: "enum-widened", path: "$" }),
    ]);
  });

  test("classifies optional to required on an input as breaking", () => {
    const before = objectSchema({ port: { type: "number" } });
    const after = objectSchema({ port: { type: "number" } }, ["port"]);

    const findings = classifySchemaChange(before, after, "input");

    expect(findings).toEqual([
      expect.objectContaining({ verdict: "breaking", changeKind: "property-required", path: "$.port" }),
    ]);
  });

  test("classifies a changed union construct as unknown", () => {
    const findings = classifySchemaChange(
      { oneOf: [{ type: "string" }, { type: "number" }] },
      { oneOf: [{ type: "string" }, { type: "boolean" }] },
      "strict",
    );

    expect(findings).toEqual([
      expect.objectContaining({ verdict: "unknown", changeKind: "unsupported-construct", path: "$.oneOf" }),
    ]);
  });

  test("accepts only the exact breaking finding named by an exception", () => {
    const findings = classifySchemaChange(
      objectSchema({ name: { type: "string" }, port: { type: "number" } }),
      objectSchema({ name: { type: "string" } }),
      "output",
    );
    const exceptions: ReadonlyArray<CompatibilityException> = [
      {
        surface: "command:app:info",
        changeKind: "property-removed",
        path: "$.port",
        justification: "The command never populated this pre-release field.",
      },
    ];

    const accepted = acceptCompatibilityExceptions("command:app:info", findings, exceptions);

    expect(accepted).toEqual([
      expect.objectContaining({ accepted: true, justification: exceptions[0]?.justification }),
    ]);
  });

  test("counts every current surface skipped when a base artifact family is unavailable", () => {
    const schema = objectSchema({ name: { type: "string" } });
    const artifacts = new Map([
      ["schema:Config", { surface: "schema:Config", polarity: "input" as const, schema }],
      ["command:app:info", { surface: "command:app:info", polarity: "output" as const, schema }],
      ["command:app:list", { surface: "command:app:list", polarity: "output" as const, schema }],
    ]);

    const notices = skippedFamilyNotices(artifacts, "origin/main", ["command"]);

    expect(notices).toEqual([
      {
        family: "command",
        count: 2,
        generatorPath: "scripts/build-schema-snapshot.ts",
        baseRef: "origin/main",
      },
    ]);
  });
});
