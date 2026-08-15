import { expect, test } from "bun:test";

import { ServiceConfig } from "@lando/sdk/schema";

import { getJsonSchema, validatePublicSchemaAnnotations } from "../../src/schema/json-schema.ts";

interface JsonSchemaProperty {
  readonly description?: unknown;
}

interface ServiceConfigJsonSchema {
  readonly properties?: Readonly<Record<string, JsonSchemaProperty | boolean>>;
}

const isServiceConfigJsonSchema = (value: unknown): value is ServiceConfigJsonSchema =>
  typeof value === "object" && value !== null && "properties" in value;

const COMPOSE_WAVE_FIELDS = ["build", "dependsOn", "environment", "healthcheck"] as const;

const publishedDescription = (field: string): unknown => {
  const schema = getJsonSchema("ServiceConfig");
  if (!isServiceConfigJsonSchema(schema)) return undefined;
  const property = schema.properties?.[field];
  return typeof property === "object" ? property.description : undefined;
};

for (const field of COMPOSE_WAVE_FIELDS) {
  test(`publishes a description for the Compose authoring field ServiceConfig.${field}`, () => {
    // Given / When
    const description = publishedDescription(field);

    // Then
    expect(typeof description).toBe("string");
    expect(description).not.toBe("");
  });

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
