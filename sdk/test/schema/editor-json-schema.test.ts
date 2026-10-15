import { expect, test } from "bun:test";
import { getEditorJsonSchema } from "@lando/sdk/schema";
import { JsonSchema } from "effect";

test.each(["LandofileShape", "GlobalConfig"] as const)("emits closed draft-07 %s editor schemas", (name) => {
  const artifact = getEditorJsonSchema(name);

  expect(artifact).toMatchObject({
    $schema: JsonSchema.META_SCHEMA_URI_DRAFT_07,
    type: "object",
    additionalProperties: false,
  });
  expect(artifact).toHaveProperty("definitions");
  expect(artifact).not.toHaveProperty("$defs");
  expect(JSON.stringify(artifact)).not.toContain("#/$defs/");
});

test("preserves Landofile extension slots and descriptions in the editor projection", () => {
  const artifact = getEditorJsonSchema("LandofileShape");

  expect(artifact).toHaveProperty(["patternProperties", "^x-"]);
  expect(artifact).not.toHaveProperty("propertyNames");
  expect(artifact).toHaveProperty("properties.name.description", expect.any(String));
  expect(artifact).toHaveProperty(
    "properties.services.additionalProperties.$ref",
    expect.stringMatching(/^#\/definitions\//),
  );
});

test("publishes native merge directive tags without widening Landofile fields", () => {
  // Given the Landofile editor projection.
  const artifact = getEditorJsonSchema("LandofileShape");

  // Then the informational tag registry names both directives and every YAML node kind.
  for (const tag of ["!override", "!reset"])
    expect(artifact).toHaveProperty(["x-lando-yaml-tags", tag, "kinds"], ["scalar", "sequence", "mapping"]);
  expect(getEditorJsonSchema("GlobalConfig")).not.toHaveProperty("x-lando-yaml-tags");
  // And no field schema admits the internal directive brand or wire envelope.
  const text = JSON.stringify({ ...artifact, "x-lando-yaml-tags": undefined });
  expect(text).not.toContain("LandofileReset");
  expect(text).not.toContain("LandofileOverride");
  expect(text).not.toContain("merge-directive");
});
