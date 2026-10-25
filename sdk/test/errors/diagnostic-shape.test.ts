import { describe, expect, test } from "bun:test";
import { Result, Schema, SchemaAST } from "effect";

import * as errors from "@lando/sdk/errors";
import { ValidationIssue } from "@lando/sdk/schema";

describe("public diagnostic contracts", () => {
  for (const [name, exported] of Object.entries(errors)) {
    if (typeof exported !== "function" || !("fields" in exported)) continue;
    const fields = exported.fields;
    if (!("_tag" in fields)) {
      test(`${name} is a diagnostic helper rather than an error class`, () => {
        expect(name).toBe("CertificateAuthorityCandidate");
        expect(Object.keys(fields).sort()).toEqual(["id", "pluginName", "source"]);
      });
      continue;
    }
    const remediation = Reflect.get(fields, "remediation");

    if (Schema.isSchema(remediation) && remediation.ast.context?.constructorDefault !== undefined) {
      test(`${name} applies its constructor default without replacing an explicit action`, () => {
        // Given the real defaulted field used by the error constructor.
        const diagnostic = Schema.Struct({ remediation });
        // When constructing with omission or a caller-specified action.
        // Constructor defaults apply at runtime; the Struct make type still lists the field.
        const omitted = diagnostic.make({} as never);
        const action = "Edit /project/custom.yml to resolve this specific failure.";
        const overridden = diagnostic.make({ remediation: action });
        // Then omission supplies a valid action and the override survives.
        expect(Schema.is(diagnostic)(omitted)).toBe(true);
        expect(omitted.remediation).not.toBe(action);
        expect(overridden.remediation).toBe(action);
        for (const blank of ["", " ", "\t\n"]) {
          expect(() => diagnostic.make({ remediation: blank })).toThrow();
        }
      });
    }

    test(`${name} requires nonblank remediation on both sides of the codec`, () => {
      // Given the actual public field, including its optionality and defaults.
      expect("remediation" in fields).toBe(true);
      if (!("remediation" in fields)) return;
      const field = fields.remediation;
      const diagnostic = Schema.Struct({ remediation: field });

      // When decoding/encoding absent, empty, whitespace, and actionable values.
      for (const remediation of [undefined, "", " ", "\t\n"]) {
        const input = remediation === undefined ? {} : { remediation };
        // Then neither wire nor decoded values may omit a useful action.
        expect(Result.isFailure(Schema.decodeUnknownResult(diagnostic)(input))).toBe(true);
        expect(Result.isFailure(Schema.encodeUnknownResult(diagnostic)(input))).toBe(true);
      }
      expect(Schema.is(diagnostic)({ remediation: "Run lando doctor." })).toBe(true);
      const jsonSchema = Schema.toJsonSchemaDocument(diagnostic).schema as {
        readonly properties?: { readonly remediation?: Record<string, unknown> };
        readonly required?: ReadonlyArray<string>;
      };
      expect(jsonSchema.required).toContain("remediation");
      expect(jsonSchema.properties?.remediation).toMatchObject({ type: "string", minLength: 1 });
      // Runtime NonEmptyString + /\S/ reject blanks even when JSON Schema omits pattern.
      expect(Schema.is(diagnostic)({ remediation: " " })).toBe(false);
      expect("suggestion" in fields).toBe(false);
    });

    if ("detail" in fields) {
      test(`${name} keeps detail textual`, () => {
        // Given the public detail field; when checking text and structured data.
        const field = fields.detail;
        // Then only text (or an omitted optional value) is accepted.
        expect(Schema.is(field)("diagnostic context")).toBe(true);
        expect(Schema.is(field)({ message: "diagnostic context" })).toBe(false);
        expect(Schema.is(field)(42)).toBe(false);
      });
    }

    if ("issues" in fields) {
      test(`${name} uses ValidationIssue elements`, () => {
        // Given one canonical issue and malformed legacy issue shapes.
        const field = fields.issues;
        const variants = SchemaAST.isUnion(field.ast) ? field.ast.types : [field.ast];
        const arrays = variants.filter(SchemaAST.isArrays);
        expect(arrays).toHaveLength(1);
        for (const array of arrays) expect(array.rest).toEqual([ValidationIssue.ast]);
        const issue = { path: ["services", "web"], message: "Invalid service." };
        expect(Schema.is(ValidationIssue)(issue)).toBe(true);
        // When checking the public issues field, then canonical issues work
        // while prose and malformed path segments cannot cross the boundary.
        expect(Schema.is(field)([issue])).toBe(true);
        expect(Schema.is(field)(["Invalid service."])).toBe(false);
        expect(Schema.is(field)([{ ...issue, path: [{}] }])).toBe(false);
      });
    }
  }
});
