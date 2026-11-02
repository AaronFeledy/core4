import { describe, expect, test } from "bun:test";
import { getEditorJsonSchema, getJsonSchema } from "@lando/sdk/schema";
import { LandofileStandardJSONSchema } from "@lando/sdk/schema/standard";
import { JsonSchema, Predicate, Result, Schema, SchemaRepresentation } from "effect";
import { importableNode } from "./landofile-parity-json-schema-fixup.ts";

const documents = [
  ["editor", () => JsonSchema.fromSchemaDraft07(getEditorJsonSchema("LandofileShape"))],
  ...(["draft-07", "draft-2020-12"] as const).map(
    (target) =>
      [
        `standard-${target}`,
        () => {
          const input = LandofileStandardJSONSchema["~standard"].jsonSchema.input({ target });
          return target === "draft-07"
            ? JsonSchema.fromSchemaDraft07(input)
            : JsonSchema.fromSchemaDraft2020_12(input);
        },
      ] as const,
  ),
  ...(["LandofileAuthoringShape", "LandofileAuthoringShapeWire"] as const).map(
    (name) => [name, () => JsonSchema.fromSchemaDraft2020_12(getJsonSchema(name))] as const,
  ),
] as const;

for (const [view, document] of documents) {
  describe(`${view} map keys`, () => {
    const schema = Schema.make<Schema.Codec<unknown>>(
      SchemaRepresentation.fromJsonSchemaDocument(document(), {
        patterns: "apply",
        onEnter: importableNode,
      }).ast,
    );
    for (const field of ["environment", "labels", "sysctls", "extra_hosts", "dependsOn", "depends_on"]) {
      test.each(["SAFE", "__proto__suffix", "constructor", "toString", "__proto__"])(
        `${field} preserves expressions while restricting key %s`,
        (key) => {
          // Given an own map key with a legitimate whole-value expression.
          const input = {
            name: "demo",
            services: { web: { [field]: Object.fromEntries([[key, "{{ recipe.value }}"]]) } },
          };
          // When the published input document validates the authored value.
          const result = Schema.decodeUnknownResult(schema)(input, { onExcessProperty: "error" });
          // Then only the exact reserved key is rejected.
          expect(Result.isSuccess(result)).toBe(key !== "__proto__");
        },
      );
    }
  });
}

for (const name of ["LandofileAuthoringFragment", "LandofileAuthoringFragmentWire"] as const) {
  test.each(["environment", "labels", "sysctls", "extra_hosts", "dependsOn", "depends_on"])(
    `${name} retains the runtime key constraint on %s`,
    (field) => {
      // Given the published partial input schema, including directive envelopes.
      const document = JsonSchema.fromSchemaDraft2020_12(getJsonSchema(name));
      const properties = document.definitions.ServiceConfigInputAuthoringFragment?.properties;
      expect(Predicate.isObject(properties)).toBe(true);
      if (!Predicate.isObject(properties)) return;
      // When inspecting every schema arm for this map field.
      const nodes: unknown[] = [properties[field]];
      const constraints: unknown[] = [];
      while (nodes.length > 0) {
        const node = nodes.pop();
        if (Predicate.isObject(node)) {
          if (node.propertyNames !== undefined) constraints.push(node.propertyNames);
          nodes.push(...Object.values(node));
        } else if (Array.isArray(node)) nodes.push(...node);
      }
      // Then the map excludes exactly the runtime-reserved property name.
      expect(constraints).toContainEqual({ not: { const: "__proto__" } });
    },
  );
}
