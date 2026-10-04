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
