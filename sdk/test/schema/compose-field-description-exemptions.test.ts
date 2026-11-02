import { expect, test } from "bun:test";

import { ServiceConfig } from "@lando/sdk/schema";
import { Predicate } from "effect";

import { getJsonSchema, validatePublicSchemaAnnotations } from "../../src/schema/json-schema.ts";

const COMPOSE_WAVE_FIELDS = [
  "build",
  "dependsOn",
  "environment",
  "envFile",
  "expose",
  "healthcheck",
  "labels",
  "ports",
] as const;

const publishedDescription = (schema: Readonly<Record<string, unknown>>, field: string): unknown => {
  if (!Predicate.isReadonlyObject(schema.properties)) return undefined;
  let property: unknown = schema.properties[field];
  const visited = new Set<object>();
  while (Predicate.isReadonlyObject(property) && !visited.has(property)) {
    visited.add(property);
    // A field-specific annotation takes precedence over its shared definition.
    if (property.description !== undefined) return property.description;
    const ref = property.$ref;
    if (typeof ref !== "string" || !ref.startsWith("#/")) return undefined;
    property = schema;
    for (const segment of decodeURIComponent(ref.slice(2)).split("/")) {
      if (!Predicate.isReadonlyObject(property)) return undefined;
      property = property[segment.replace(/~1/g, "/").replace(/~0/g, "~")];
    }
  }
  return undefined;
};

for (const field of COMPOSE_WAVE_FIELDS) {
  test.each(["ServiceConfig", "ServiceConfigInput"] as const)(
    `publishes a description for the Compose authoring field %s.${field}`,
    (name) => {
      // Given
      const schema = getJsonSchema(name);

      // When
      const description = publishedDescription(schema, field);

      // Then
      expect(typeof description).toBe("string");
      expect(typeof description === "string" && description.trim().length > 0).toBe(true);
    },
  );

  test(`does not exempt ServiceConfig.${field} from the field-description gate`, async () => {
    // Given / When
    const source = await Bun.file(new URL("../../src/schema/json-schema.ts", import.meta.url)).text();
    const issues = validatePublicSchemaAnnotations({ ServiceConfig }).filter(
      (issue) => issue.path === `ServiceConfig.${field}`,
    );

    // Then
    expect(source.includes(`"ServiceConfig.${field}",`)).toBe(false);
    expect(issues).toEqual([]);
  });
}

test.each([
  ["inline", { description: "field-specific" }, {}, "field-specific"],
  ["shared", { $ref: "#/$defs/Shared" }, { Shared: { description: "shared" } }, "shared"],
  [
    "sibling precedence",
    { $ref: "#/$defs/Shared", description: "field-specific" },
    { Shared: { description: "shared" } },
    "field-specific",
  ],
  ["missing definition", { $ref: "#/$defs/Shared" }, {}, undefined],
  ["missing description", { $ref: "#/$defs/Shared" }, { Shared: { type: "string" } }, undefined],
  ["empty sibling", { $ref: "#/$defs/Shared", description: "" }, { Shared: { description: "shared" } }, ""],
  [
    "chained reference",
    { $ref: "#/$defs/Alias" },
    { Alias: { $ref: "#/$defs/Shared" }, Shared: { description: "shared" } },
    "shared",
  ],
  ["cyclic reference", { $ref: "#/$defs/Shared" }, { Shared: { $ref: "#/$defs/Shared" } }, undefined],
  ["escaped pointer", { $ref: "#/$defs/A~1B~0C%20D" }, { "A/B~C D": { description: "shared" } }, "shared"],
] as const)("resolves published field descriptions with %s metadata", (_name, property, $defs, expected) => {
  // Given
  const schema = { properties: { field: property }, $defs };

  // When
  const description = publishedDescription(schema, "field");

  // Then
  expect(description).toBe(expected);
});
