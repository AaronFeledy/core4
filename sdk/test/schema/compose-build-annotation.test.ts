import { ServiceConfig } from "@lando/sdk/schema";

import { getJsonSchema, validatePublicSchemaAnnotations } from "../../src/schema/json-schema.ts";

interface JsonSchemaProperty {
  readonly description?: unknown;
}

interface ServiceConfigJsonSchema {
  readonly properties?: Readonly<Record<string, JsonSchemaProperty | boolean>>;
}

test("publishes a description for the discriminated ServiceConfig.build field", () => {
  // Given / When
  const schema: ServiceConfigJsonSchema = getJsonSchema("ServiceConfig");
  const build = schema.properties?.build;
  const description = typeof build === "object" ? build.description : undefined;

  // Then
  expect(typeof description).toBe("string");
  if (typeof description !== "string") throw new Error("ServiceConfig.build description is missing");
  expect(description.length).toBeGreaterThan(0);
});

test("does not exempt ServiceConfig.build from the field-description gate", async () => {
  // Given / When
  const source = await Bun.file(new URL("../../src/schema/json-schema.ts", import.meta.url)).text();
  const buildIssues = validatePublicSchemaAnnotations({ ServiceConfig }).filter(
    (issue) => issue.path === "ServiceConfig.build",
  );

  // Then
  expect(source.includes('"ServiceConfig.build",')).toBe(false);
  expect(buildIssues).toEqual([]);
});
