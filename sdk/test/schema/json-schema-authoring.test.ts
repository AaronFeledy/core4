import { describe, expect, test } from "bun:test";
import { JSON_SCHEMA_NAMES, getJsonSchema, validatePublicSchemaAnnotations } from "@lando/sdk/schema";

describe("authoring JSON Schema publication", () => {
  test("publishes router and fragment definitions when requesting the authoring fragment", () => {
    // Given an expression-aware recursive fragment contract.
    const name = "LandofileAuthoringFragment";
    // When its public artifact is emitted.
    const schema = getJsonSchema(name);
    // Then the object member keeps its properties and fragment-specific definitions survive publication.
    const root = (schema as { $defs?: Record<string, { anyOf?: ReadonlyArray<Record<string, unknown>> }> })
      .$defs?.[name];
    expect(
      root?.anyOf?.some((member) => "properties" in member && "router" in (member.properties as object)),
    ).toBe(true);
    expect(schema).toHaveProperty("$defs.ServiceConfigInputAuthoringFragment");
    expect(schema).not.toHaveProperty("$defs.ServiceConfigInput");
  });

  test("keeps complete and partial definitions distinct when publishing encode input", () => {
    // Given an encoder accepting complete context and a partial fragment.
    const name = "ConfigTranslateEncodeInput";
    // When both trees share an artifact.
    const schema = getJsonSchema(name);
    // Then the complete context and the partial fragment stay separate wire members.
    const definition = (schema as { $defs?: Record<string, unknown> }).$defs?.[name] as
      | { properties?: Record<string, unknown> }
      | undefined;
    expect(
      definition?.properties ?? (schema as { properties?: Record<string, unknown> }).properties,
    ).toHaveProperty("context");
    expect(
      definition?.properties ?? (schema as { properties?: Record<string, unknown> }).properties,
    ).toHaveProperty("fragment");
    expect(schema).not.toHaveProperty("$defs.ServiceConfigInput");
  });

  test("passes annotation validation when publishing the public registry", () => {
    // Given the default public registry and inherited field exemptions.
    // When all registered annotations are validated.
    const issues = validatePublicSchemaAnnotations();
    // Then publication has no annotation debt beyond existing exemptions.
    expect(issues).toEqual([]);
  });

  test("includes translation results when listing public schema names", () => {
    // Given the public registry.
    // When its artifact names are enumerated.
    const names = JSON_SCHEMA_NAMES;
    // Then translation results have a published artifact.
    expect(names).toContain("ConfigTranslateResult");
  });
});
