import { JsonSchema } from "effect";

import { GlobalConfig } from "./config.ts";
import { jsonSchemaDocument, withSchemaDeprecations } from "./json-schema-deprecations.ts";
import { repairLandofileExtensions } from "./json-schema-extensions.ts";
import { LandofileShape } from "./landofile.ts";

/** Draft-07 projection for YAML editors, derived from the public contracts. */
export const getEditorJsonSchema = (name: "LandofileShape" | "GlobalConfig"): JsonSchema.JsonSchema => {
  const schema = { LandofileShape, GlobalConfig }[name];
  const document = JsonSchema.toDocumentDraft07(
    jsonSchemaDocument(schema, { onExcessProperty: "error", generateDescriptions: true }),
  );
  const artifact = withSchemaDeprecations(schema, {
    $schema: JsonSchema.META_SCHEMA_URI_DRAFT_07,
    ...document.schema,
    ...(Object.keys(document.definitions).length === 0 ? {} : { definitions: document.definitions }),
  });
  if (name === "LandofileShape") repairLandofileExtensions(artifact);
  return artifact;
};
