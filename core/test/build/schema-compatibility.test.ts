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
